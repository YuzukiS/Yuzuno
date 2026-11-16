use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
};

const SCRIPT: &[u8] = include_bytes!("host.py");
/// Test fault injection: Cores with these data folders run on macOS, as far
/// as `local_host` and `mac_core` can tell, while the test itself runs on Linux.
#[cfg(test)]
pub(super) static NOT_LINUX: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
fn host_os(data: &Path) -> &'static str {
    #[cfg(test)]
    if NOT_LINUX.lock().unwrap().iter().any(|d| data.starts_with(d)) {
        return "macos";
    }
    let _ = data;
    std::env::consts::OS
}
/// Whether this Core runs on a Mac (YN-108 M2c): its own Jobs then run on
/// This Mac (remote.rs `MAC`) through the Jobs helper a Mac reached over SSH
/// runs, never as local Jobs here.
pub(super) fn mac_core(data: &Path) -> bool {
    host_os(data) == "macos"
}
/// Whether this Core's own host can run local Jobs. They need Linux with a
/// systemd user manager (host.py); elsewhere they are refused before the
/// helper is written or run and before anything is queued. On macOS a Job
/// runs on This Mac instead, which has no runs of stages or checkpoints.
pub(super) fn local_host(data: &Path) -> Result<()> {
    let os = host_os(data);
    if os == "macos" {
        bail!("Runs of stages and checkpoints need Linux with a systemd user manager, and this Core runs on macOS, where job_submit runs a Job on This Mac in the limited mode instead: nothing was written, run or queued on this host. A Job for a registered remote machine (machineId) is not affected by this.");
    }
    ensure!(
        os == "linux",
        "Local Jobs need Linux with a systemd user manager, and this Core runs on {os}: nothing was written, run or queued on this host. A Job for a registered remote machine (machineId) is not affected by this."
    );
    Ok(())
}
/// Whether this host's Jobs budget is used here: by its local Jobs on Linux,
/// by This Mac's on macOS, where it only queues and records them.
pub(super) fn budget_host(data: &Path) -> Result<()> {
    if mac_core(data) {
        return Ok(());
    }
    local_host(data)
}
pub(super) async fn helper(data: &Path) -> Result<PathBuf> {
    local_host(data)?;
    #[cfg(test)]
    if let Some((_, stub)) = HELPERS.lock().unwrap().iter().find(|(dir, _)| data.starts_with(dir)) {
        return Ok(stub.clone());
    }
    let root = data.join("jobs");
    tokio::fs::create_dir_all(&root).await?;
    let path = root.join(format!("host-{:x}.py", Sha256::digest(SCRIPT)));
    write_once(&path, SCRIPT).await?;
    Ok(path)
}
/// Tests: for the data folders named here, a cgroup root of the test's own
/// (watch.rs, `usage`) and a stand-in for the host helper.
#[cfg(test)]
pub(super) static CGROUPS: std::sync::Mutex<Vec<(PathBuf, PathBuf)>> = std::sync::Mutex::new(Vec::new());
#[cfg(test)]
pub(super) static HELPERS: std::sync::Mutex<Vec<(PathBuf, PathBuf)>> = std::sync::Mutex::new(Vec::new());
/// Where this host's cgroup v2 hierarchy is.
pub(super) fn cgroup_root(data: &Path) -> PathBuf {
    #[cfg(test)]
    if let Some((_, root)) = CGROUPS.lock().unwrap().iter().find(|(dir, _)| data.starts_with(dir)) {
        return root.clone();
    }
    let _ = data;
    PathBuf::from("/sys/fs/cgroup")
}
/// Test fault injection: writes under these folders fail as a full disk
/// would (ENOSPC), without filling any real disk.
#[cfg(test)]
pub(super) static FULL_DISK: std::sync::Mutex<Vec<PathBuf>> = std::sync::Mutex::new(Vec::new());
async fn write_once(path: &Path, bytes: &[u8]) -> Result<()> {
    #[cfg(test)]
    if FULL_DISK.lock().unwrap().iter().any(|full| path.starts_with(full)) {
        return Err(std::io::Error::from_raw_os_error(28).into());
    }
    if tokio::fs::try_exists(path).await? {
        ensure!(
            tokio::fs::read(path).await? == bytes,
            "Existing job file has different content: {}",
            path.display()
        );
        return Ok(());
    }
    let path = path.to_owned();
    let bytes = bytes.to_vec();
    // Install complete, synced bytes atomically. A crash or concurrent submit
    // cannot expose a partially written helper, spec, or launch/cancel intent.
    crate::db::blocking(move || {
        use std::io::Write;
        let parent = path.parent().context("Missing job directory")?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(&bytes)?;
        file.as_file().sync_all()?;
        match file.persist_noclobber(&path) {
            Ok(_) => {}
            Err(e) if e.error.kind() == std::io::ErrorKind::AlreadyExists => {
                ensure!(
                    std::fs::read(&path)? == bytes,
                    "Existing job file has different content: {}",
                    path.display()
                );
            }
            Err(e) => return Err(e.into()),
        }
        std::fs::File::open(parent)?.sync_all()?;
        Ok(())
    })
    .await
}
/// The input guard's refusal (T-29): host.py ends a refused snapshot with one
/// line, `yuzuno-input-guard {json}`. Its problem names the input and the
/// limit; the rest of stderr, the helper's own path included, is left out.
fn input_guard(stderr: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(stderr);
    let line = text.lines().rev().find(|line| !line.trim().is_empty())?;
    let detail: Value = serde_json::from_str(line.strip_prefix("yuzuno-input-guard ")?).ok()?;
    detail["problem"].as_str().filter(|problem| !problem.is_empty()).map(str::to_owned)
}
async fn run(mut cmd: Command, input: Option<Value>, seconds: u64) -> Result<Value> {
    cmd.stdin(if input.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
    let mut child = cmd.spawn()?;
    if let Some(input) = input {
        let mut stdin = child.stdin.take().context("Missing helper stdin")?;
        stdin.write_all(&serde_json::to_vec(&input)?).await?;
        drop(stdin);
    }
    let output = child.stdout.take().context("Missing helper stdout")?;
    let error = child.stderr.take().context("Missing helper stderr")?;
    let execution = async {
        let read = async {
            let mut b = Vec::new();
            output.take(1024 * 1024 + 1).read_to_end(&mut b).await?;
            Result::<_>::Ok(b)
        };
        let err = async {
            let mut b = Vec::new();
            error.take(16385).read_to_end(&mut b).await?;
            Result::<_>::Ok(b)
        };
        let (out, err, status) = tokio::try_join!(read, err, async {
            Ok::<_, anyhow::Error>(child.wait().await?)
        })?;
        ensure!(
            out.len() <= 1024 * 1024 && err.len() <= 16384,
            "Host helper output exceeded its bound"
        );
        if !status.success() {
            if let Some(problem) = input_guard(&err) {
                bail!("Input guard refused these inputs: {problem}");
            }
        }
        ensure!(
            status.success(),
            "Host helper failed: {}",
            String::from_utf8_lossy(&err)
        );
        Ok(if out.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(&out)?
        })
    };
    tokio::time::timeout(Duration::from_secs(seconds), execution)
        .await
        .context("Host helper timed out; outcome must be reconciled")?
}
pub(super) async fn invoke(
    script: &Path,
    mode: &str,
    spec: Option<&Path>,
    input: Option<Value>,
) -> Result<Value> {
    let mut cmd = Command::new("/usr/bin/python3");
    cmd.arg(script).arg(mode);
    if let Some(spec) = spec {
        cmd.arg(spec);
    }
    run(cmd, input, 40).await
}
pub(super) async fn machine_info() -> Result<Value> {
    #[cfg(target_os = "macos")]
    return mac::machine_info();
    #[cfg(not(target_os = "macos"))]
    linux_machine_info().await
}
#[cfg(not(target_os = "macos"))]
async fn linux_machine_info() -> Result<Value> {
    ensure!(
        cfg!(target_os = "linux"),
        "Local managed jobs require Linux with a systemd user manager"
    );
    let mem = tokio::fs::read_to_string("/proc/meminfo").await?;
    let value = |key: &str| {
        mem.lines()
            .find_map(|l| {
                l.strip_prefix(key)
                    .and_then(|v| v.split_whitespace().next())
                    .and_then(|v| v.parse::<u64>().ok())
            })
            .map(|v| v / 1024)
    };
    let total = value("MemTotal:").context("Host memory capacity unavailable")?;
    let cpus = std::thread::available_parallelism()?.get() as u64;
    let (suggested, headroom) = budget_defaults(cpus, total);
    let identity = tokio::fs::read_to_string("/etc/machine-id").await?;
    let boot = tokio::fs::read_to_string("/proc/sys/kernel/random/boot_id").await?;
    let name = tokio::fs::read_to_string("/proc/sys/kernel/hostname")
        .await?
        .trim()
        .to_owned();
    Ok(
        json!({"id":format!("local-{:x}",Sha256::digest(identity.trim().as_bytes())),"name":name,"bootId":boot.trim(),
        "memoryTotalMiB":total,"memoryAvailableMiB":value("MemAvailable:"),"swapTotalMiB":value("SwapTotal:"),"swapFreeMiB":value("SwapFree:"),"logicalCpus":cpus,
        "suggestedBudget":suggested,
        "hostHeadroomMiB":headroom,
        "scope":"Only jobs managed by this Core share this budget. CPU is a quota, not physical-core reservation. WSL shares host RAM with Windows; other applications are outside this budget."}),
    )
}
/// This Mac's facts in Linux's shape (YN-108 M2c): its logical CPUs, its
/// memory (hw.memsize), the machine (gethostuuid, hashed as /etc/machine-id
/// is) and this boot (kern.bootsessionuuid, as remote_job.py reads it). macOS
/// names no available memory or swap in these terms: they are unknown.
#[cfg(target_os = "macos")]
mod mac {
    use anyhow::{ensure, Context, Result};
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::ffi::CStr;

    pub(super) fn machine_info() -> Result<Value> {
        let total = sysctl_u64(c"hw.memsize")? / 1_048_576;
        let cpus = std::thread::available_parallelism()?.get() as u64;
        let (suggested, headroom) = super::budget_defaults(cpus, total);
        let identity = host_uuid()?;
        let boot = sysctl_string(c"kern.bootsessionuuid")?;
        Ok(json!({"id":format!("local-{:x}",Sha256::digest(identity.as_bytes())),"name":host_name(),"bootId":boot,
            "memoryTotalMiB":total,"memoryAvailableMiB":null,"swapTotalMiB":null,"swapFreeMiB":null,"logicalCpus":cpus,
            "suggestedBudget":suggested,
            "hostHeadroomMiB":headroom,
            "scope":"Only Jobs managed by this Core share this budget, and only to queue and record them: macOS holds no CPU or RAM limit, so a Job on This Mac can use more than it declared. Other applications are outside this budget."}))
    }

    /// A sysctl the kernel answers with a 64-bit integer.
    fn sysctl_u64(name: &CStr) -> Result<u64> {
        let mut value = 0u64;
        let mut size = std::mem::size_of::<u64>();
        // SAFETY: `name` is NUL-terminated; the kernel writes at most `size`
        // bytes into `value`, which has that size, and reports what it wrote.
        let done = unsafe { libc::sysctlbyname(name.as_ptr(), (&raw mut value).cast(), &mut size, std::ptr::null_mut(), 0) };
        ensure!(done == 0 && size == std::mem::size_of::<u64>(), "sysctl {name:?} could not be read: {}", std::io::Error::last_os_error());
        Ok(value)
    }

    /// A sysctl the kernel answers with a string.
    fn sysctl_string(name: &CStr) -> Result<String> {
        let mut buffer = [0u8; 256];
        let mut size = buffer.len();
        // SAFETY: as for sysctl_u64, into a buffer of `size` bytes.
        let done = unsafe { libc::sysctlbyname(name.as_ptr(), buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) };
        ensure!(done == 0 && size <= buffer.len(), "sysctl {name:?} could not be read: {}", std::io::Error::last_os_error());
        let text = CStr::from_bytes_until_nul(&buffer[..size]).context("its value is not a string")?;
        let text = text.to_str().context("its value is not UTF-8")?.trim().to_owned();
        ensure!(!text.is_empty(), "sysctl {name:?} is empty");
        Ok(text)
    }

    /// This Mac's hardware UUID, as 32 hex digits.
    fn host_uuid() -> Result<String> {
        let mut uuid = [0u8; 16];
        let wait = libc::timespec { tv_sec: 1, tv_nsec: 0 };
        // SAFETY: gethostuuid writes exactly 16 bytes (a uuid_t) into `uuid`.
        let done = unsafe { libc::gethostuuid(uuid.as_mut_ptr(), &wait) };
        ensure!(done == 0, "this Mac's hardware UUID could not be read: {}", std::io::Error::last_os_error());
        Ok(uuid.iter().map(|b| format!("{b:02x}")).collect())
    }

    fn host_name() -> String {
        let mut buffer = [0u8; 256];
        // SAFETY: gethostname writes at most `len` bytes, NUL-terminated when it fits.
        let done = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        let name = (done == 0).then(|| CStr::from_bytes_until_nul(&buffer).ok()).flatten();
        name.and_then(|name| name.to_str().ok()).map(str::trim).filter(|name| !name.is_empty()).unwrap_or("unknown").to_owned()
    }
}
// The budget a Workspace starts with stays conservative. The user may save
// any budget within the fixed input bounds (see validate_budget): this host's
// totals are shown for reference, not as a ceiling. Admission still checks
// the RAM available now, keeping this headroom for Core and the desktop.
pub(super) fn budget_defaults(cpus: u64, total: u64) -> (super::Resources, u64) {
    let headroom = (total / 16).clamp(128, 2048);
    let suggested = super::Resources {
        cpu_millis: cpus.saturating_mul(500).clamp(200, 4000),
        memory_mi_b: (total / 4).min(8192).min(total.saturating_sub(headroom)),
        swap_mi_b: 0,
    };
    (suggested, headroom)
}
pub(super) fn folder(data: &Path, job: &Value) -> Result<PathBuf> {
    let id = job["id"].as_str().context("Job identity missing")?;
    uuid::Uuid::parse_str(id).context("Invalid job identity")?;
    Ok(data.join("jobs").join(id))
}
async fn prepare(data: &Path, job: &Value) -> Result<(PathBuf, PathBuf)> {
    let dir = folder(data, job)?;
    tokio::fs::create_dir_all(&dir).await?;
    let spec = dir.join("spec.json");
    // The initial immutable spec excludes evolving DB state on recovery.
    if !tokio::fs::try_exists(&spec).await? {
        write_once(&spec, &serde_json::to_vec(job)?).await?;
    }
    let saved: Value = serde_json::from_slice(&tokio::fs::read(&spec).await?)?;
    ensure!(
        saved["id"] == job["id"] && saved["attempt"] == job["attempt"],
        "Attempt directory has a different identity"
    );
    Ok((dir, spec))
}
/// Why a launch did not report back. `dispatched.json` is written, synced,
/// before systemd-run is called: without it no worker was ever created.
#[derive(Debug)]
pub(super) enum LaunchError {
    /// Failed before the attempt was dispatched: certainly no process.
    NotStarted(anyhow::Error),
    /// systemd-run may have started the unit: only reconciliation can tell.
    Unconfirmed(anyhow::Error),
}
/// Whether this attempt was ever handed to systemd-run.
pub(super) async fn dispatched(data: &Path, job: &Value) -> Result<bool> {
    Ok(tokio::fs::try_exists(folder(data, job)?.join("dispatched.json")).await?)
}
pub(super) async fn launch(data: &Path, job: &Value) -> Result<(), LaunchError> {
    let dir = folder(data, job).map_err(LaunchError::NotStarted)?;
    let marker = dir.join("dispatched.json");
    // A marker that exists, or cannot be checked, may mean a worker exists.
    if tokio::fs::try_exists(&marker).await.unwrap_or(true) {
        return Err(LaunchError::Unconfirmed(anyhow::anyhow!(
            "Attempt has already been dispatched, or its marker cannot be read; reconcile without retry"
        )));
    }
    let (script, spec) = async {
        let script = helper(data).await?;
        let (_, spec) = prepare(data, job).await?;
        // What the Job reads its grant from (T-64), there before it starts.
        let granted = job["cpuGrantedAtStart"].as_u64().or(job["resources"]["cpuMillis"].as_u64()).context("Missing CPU grant")?;
        write_cpu_file(data, job, granted).await?;
        write_once(
            &marker,
            &serde_json::to_vec(
                &json!({"jobId":job["id"],"attempt":job["attempt"],"bootId":job["bootId"]}),
            )?,
        )
        .await?;
        Ok::<_, anyhow::Error>((script, spec))
    }
    .await
    .with_context(|| format!("Could not prepare its launch record in {}", dir.display()))
    .map_err(LaunchError::NotStarted)?;
    systemd_run(job, &script, &spec).await.map_err(LaunchError::Unconfirmed)
}
async fn systemd_run(job: &Value, script: &Path, spec: &Path) -> Result<()> {
    let mut cmd = Command::new("systemd-run");
    cmd.args([
        "--user",
        "--quiet",
        "--collect",
        "--service-type=exec",
        "--expand-environment=no",
    ])
    .arg(format!(
        "--unit={}",
        job["supervisorUnit"].as_str().unwrap()
    ))
    .arg("-p")
    .arg(format!(
        "Description=Yuzuno job {}",
        job["attempt"].as_str().unwrap()
    ))
    .args([
        "-p",
        "MemoryMax=64M",
        "-p",
        "MemorySwapMax=0",
        "-p",
        "CPUQuota=10%",
        "-p",
        "TasksMax=16",
        "-p",
        "Restart=no",
        "-p",
        "KillMode=control-group",
        "-p",
        "TimeoutStopSec=3s",
        "-p",
        "StandardOutput=null",
        "-p",
        "StandardError=null",
    ])
    .arg("-p")
    .arg(format!(
        "RuntimeMaxSec={}s",
        job["timeoutSeconds"].as_u64().unwrap() + 60
    ))
    .arg("--")
    .arg("/usr/bin/python3")
    .arg(script)
    .arg("supervise")
    .arg(spec);
    run(cmd, None, 15).await?;
    Ok(())
}
pub(super) async fn observe(data: &Path, job: &Value) -> Result<Option<Value>> {
    let dir = folder(data, job)?;
    // Never handed to systemd-run (Core stopped, or its launch record could
    // not be written): no process exists, so nothing is held for it.
    if !dispatched(data, job).await? {
        let cancelled = job["cancelRequestedAt"].is_string();
        return Ok(Some(json!({"jobId":job["id"],"attempt":job["attempt"],
            "status": if cancelled { "cancelled" } else { "rejected" },
            "reason": if cancelled {
                "Cancelled; this attempt was never dispatched, so no process was created"
            } else {
                "Not started: this attempt was never dispatched (no launch marker in its job folder), so no process was created. The reservation is released; submit again with a new requestId to retry."
            },
            "evidence":{"coreObservation":true,"notStarted":true}})));
    }
    let script = helper(data).await?;
    if job["cancelRequestedAt"].is_string() {
        let (_, spec) = prepare(data, job).await?;
        write_once(
            &dir.join("cancel.json"),
            &serde_json::to_vec(
                &json!({"attempt":job["attempt"],"requestedAt":job["cancelRequestedAt"]}),
            )?,
        )
        .await?;
        let result = invoke(&script, "cancel", Some(&spec), None).await?;
        return Ok((result["status"] != "settling").then_some(result));
    }
    let spec = dir.join("spec.json");
    ensure!(tokio::fs::try_exists(&spec).await?,"The attempt was dispatched but its launch record is missing; no automatic retry. Cancel to reconcile and release the reservation.");
    let state = invoke(&script, "reconcile", Some(&spec), None).await?;
    if state["status"] == "settling" {
        return Ok(None);
    }
    if state["status"] != "unresolved" {
        return Ok(Some(state));
    }
    let proof = &state["started"];
    if proof["attempt"] == job["attempt"]
        && proof["invocationId"] == state["systemd"]["InvocationID"]
        && state["systemd"]["SubState"] == "running"
    {
        return Ok(Some(
            json!({"jobId":job["id"],"attempt":job["attempt"],"status":"running","reason":"Running with verified cgroup limits","started":proof,"evidence":state["systemd"],"freezer":state["freezer"],"command":state["command"]}),
        ));
    }
    if state["supervisor"]["ActiveState"] == "active" {
        return Ok(None);
    }
    Ok(Some(
        json!({"jobId":job["id"],"attempt":job["attempt"],"status":"unknown","reason":"No retained terminal evidence; reservation held. Cancel to verify process groups before retrying.","evidence":state}),
    ))
}

/// Pause or resume this attempt's own worker (host.py `pause`/`resume`), or
/// ask its wrapper to stop the command at a checkpoint (`checkpoint`).
pub(super) async fn control(data: &Path, job: &Value, mode: &str) -> Result<Value> {
    ensure!(matches!(mode, "pause" | "resume" | "checkpoint"), "Unknown job control");
    let script = helper(data).await?;
    let spec = folder(data, job)?.join("spec.json");
    ensure!(
        tokio::fs::try_exists(&spec).await?,
        "The attempt has no launch record; nothing was changed"
    );
    invoke(&script, mode, Some(&spec), None).await
}

/// Lower this attempt's own worker's memory limit (host.py `limit`, T-38).
pub(super) async fn limit(data: &Path, job: &Value, memory_mib: u64) -> Result<Value> {
    let script = helper(data).await?;
    let spec = folder(data, job)?.join("spec.json");
    ensure!(
        tokio::fs::try_exists(&spec).await?,
        "The attempt has no launch record; nothing was changed"
    );
    invoke(&script, "limit", Some(&spec), Some(serde_json::json!({"memoryMiB": memory_mib}))).await
}

/// Raise this attempt's own worker's CPU quota to `millis` (host.py `cpu`, T-64).
pub(super) async fn raise_cpu(data: &Path, job: &Value, millis: u64) -> Result<Value> {
    let script = helper(data).await?;
    let spec = folder(data, job)?.join("spec.json");
    ensure!(
        tokio::fs::try_exists(&spec).await?,
        "The attempt has no launch record; nothing was changed"
    );
    invoke(&script, "cpu", Some(&spec), Some(serde_json::json!({"cpuMillis": millis}))).await
}

/// The file YUZUNO_JOB_CPU_FILE names: the Job's CPU grant now, in
/// millicores, on one line (T-64). Written before its launch and after each
/// raise, never before its cgroup allows it, and replaced whole.
pub(super) const CPU_FILE: &str = "cpu-millis";
pub(super) async fn write_cpu_file(data: &Path, job: &Value, millis: u64) -> Result<()> {
    let dir = folder(data, job)?;
    let staged = dir.join(format!("{CPU_FILE}.{}", uuid::Uuid::new_v4()));
    tokio::fs::write(&staged, format!("{millis}\n")).await?;
    if let Err(error) = tokio::fs::rename(&staged, dir.join(CPU_FILE)).await {
        let _ = tokio::fs::remove_file(&staged).await;
        return Err(error).context("The CPU grant file was not replaced");
    }
    Ok(())
}

/// Whether this attempt's wrapper recorded that its command has exited
/// (host.py `CHECKPOINT_EXIT`). Unreadable means not known to have exited.
pub(super) async fn command_exited(data: &Path, job: &Value) -> bool {
    let Ok(dir) = folder(data, job) else {
        return false;
    };
    let Ok(bytes) = tokio::fs::read(dir.join("checkpoint-exit.json")).await else {
        return false;
    };
    serde_json::from_slice::<Value>(&bytes).is_ok_and(|exit| exit["attempt"] == job["attempt"])
}

pub(super) async fn logs(data: &Path, job: &Value, offset: Option<u64>) -> Result<Value> {
    let dir = folder(data, job)?;
    let mut chunks = Vec::new();
    for index in 0..2 {
        let path = dir.join(format!("log-{index}.bin"));
        let file = match tokio::fs::File::open(path).await {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let mut bytes = Vec::new();
        file.take(1024 * 1024 + 8).read_to_end(&mut bytes).await?;
        if bytes.len() < 8 {
            continue;
        }
        let start = u64::from_be_bytes(bytes[..8].try_into().unwrap());
        chunks.push((start, bytes.split_off(8)));
    }
    chunks.sort_by_key(|c| c.0);
    let oldest = chunks.first().map_or(0, |c| c.0);
    let total = chunks.last().map_or(0, |c| c.0 + c.1.len() as u64);
    let requested = offset.unwrap_or(total.saturating_sub(32768));
    let start = requested.max(oldest).min(total);
    let end = (start + 32768).min(total);
    let mut bytes = Vec::new();
    for (at, part) in chunks {
        let lo = start.saturating_sub(at).min(part.len() as u64) as usize;
        let hi = end.saturating_sub(at).min(part.len() as u64) as usize;
        if hi > lo {
            bytes.extend_from_slice(&part[lo..hi]);
        }
    }
    Ok(
        json!({"jobId":job["id"],"offset":start,"nextOffset":end,"oldestOffset":oldest,"totalBytes":total,"truncated":requested<oldest,"text":String::from_utf8_lossy(&bytes),"retainedBytesLimit":2097152}),
    )
}
/// How much output an attempt's log ring holds, from its two segment
/// headers and sizes alone: none of the output is read.
pub(super) async fn log_extent(data: &Path, job: &Value) -> Result<Value> {
    let dir = folder(data, job)?;
    let mut segments = Vec::new();
    for index in 0..2 {
        let mut file = match tokio::fs::File::open(dir.join(format!("log-{index}.bin"))).await {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e.into()),
        };
        let length = file.metadata().await?.len();
        if length < 8 {
            continue;
        }
        let mut header = [0u8; 8];
        file.read_exact(&mut header).await?;
        segments.push((u64::from_be_bytes(header), (length - 8).min(1024 * 1024)));
    }
    segments.sort_by_key(|s| s.0);
    let oldest = segments.first().map_or(0, |s| s.0);
    let total = segments.last().map_or(0, |s| s.0 + s.1);
    Ok(json!({"segments":segments.len(),"oldestOffset":oldest,"totalBytes":total,"truncated":oldest>0}))
}
/// A live attempt's usage, from its worker's own cgroup (T-59): under
/// systemd's names and in its units, for what the cgroup counts, with no
/// helper run. Null without this attempt's start receipt of this boot, or
/// once its cgroup is gone (the outcome's systemd evidence then has them).
pub(super) async fn usage(data: &Path, job: &Value) -> Result<Value> {
    if job["reserved"] != true {
        return Ok(Value::Null);
    }
    let Ok(bytes) = tokio::fs::read(folder(data, job)?.join("started.json")).await else {
        return Ok(Value::Null);
    };
    let proof: Value = serde_json::from_slice(&bytes)?;
    let boot = tokio::fs::read_to_string("/proc/sys/kernel/random/boot_id").await?;
    let Some(path) = proof["controlGroup"].as_str().filter(|_| proof["attempt"] == job["attempt"] && proof["bootId"] == boot.trim()) else {
        return Ok(Value::Null);
    };
    let group = cgroup_root(data).join(path.trim_start_matches('/'));
    if !tokio::fs::try_exists(&group).await? {
        return Ok(Value::Null);
    }
    let mut usage = serde_json::Map::new();
    for (name, file) in [("MemoryCurrent", "memory.current"), ("MemoryPeak", "memory.peak"), ("MemoryMax", "memory.max"),
        ("MemorySwapMax", "memory.swap.max"), ("TasksMax", "pids.max"), ("CPUUsageNSec", "cpu.stat")]
    {
        let text = tokio::fs::read_to_string(group.join(file)).await.ok();
        let value = match (file, text.as_deref().map(str::trim)) {
            ("cpu.stat", Some(stat)) => stat.lines().find_map(|line| line.strip_prefix("usage_usec "))
                .and_then(|usec| usec.trim().parse::<u64>().ok()).map(|usec| (usec * 1000).to_string()),
            (_, Some("max")) => Some("infinity".to_owned()),
            (_, Some(value)) => value.parse::<u64>().ok().map(|value| value.to_string()),
            (_, None) => None,
        };
        usage.insert(name.to_owned(), json!(value.unwrap_or_else(|| "[not set]".to_owned())));
    }
    Ok(Value::Object(usage))
}
/// A live attempt's own reports so far: usage/cost and progress.
pub(super) async fn reports(data: &Path, job: &Value) -> Result<Value> {
    if job["reserved"] != true {
        return Ok(Value::Null);
    }
    let script = helper(data).await?;
    let spec = folder(data, job)?.join("spec.json");
    if !tokio::fs::try_exists(&spec).await? {
        return Ok(Value::Null);
    }
    invoke(&script, "reports", Some(&spec), None).await
}
/// The file of a verified artifact, checked again now against the size and
/// SHA-256 its attempt recorded.
pub(super) async fn artifact_path(data: &Path, job: &Value, index: usize) -> Result<PathBuf> {
    let recorded = job["result"]["artifacts"]
        .as_array()
        .and_then(|all| all.get(index))
        .filter(|a| a["ok"] == true)
        .context("This attempt has no verified artifact at that position")?;
    let script = helper(data).await?;
    let now = invoke(
        &script,
        "verify",
        None,
        Some(json!({"cwd":job["cwd"],"artifacts":[recorded]})),
    )
    .await?;
    let current = &now[0];
    ensure!(
        super::runs::same_artifact(recorded, current),
        "{} is no longer the file this attempt produced ({}); it was overwritten or removed after the attempt",
        recorded["path"].as_str().unwrap_or(""),
        current["problem"].as_str().unwrap_or("its content changed")
    );
    Ok(PathBuf::from(
        current["absolutePath"].as_str().context("Verified artifact has no path")?,
    ))
}
pub(super) async fn output_path(job: &Value, index: usize) -> Result<PathBuf> {
    let relative = job["outputs"]
        .as_array()
        .and_then(|v| v.get(index))
        .and_then(Value::as_str)
        .context("Declared output not found")?;
    let cwd = tokio::fs::canonicalize(job["cwd"].as_str().context("Missing job cwd")?).await?;
    let path = tokio::fs::canonicalize(cwd.join(relative))
        .await
        .context("Output file is not available yet")?;
    ensure!(
        path.starts_with(&cwd) && tokio::fs::metadata(&path).await?.is_file(),
        "Output must remain inside the job directory"
    );
    Ok(path)
}
