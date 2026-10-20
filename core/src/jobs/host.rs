use anyhow::{ensure, Context, Result};
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
pub(super) async fn helper(data: &Path) -> Result<PathBuf> {
    let root = data.join("jobs");
    tokio::fs::create_dir_all(&root).await?;
    let path = root.join(format!("host-{:x}.py", Sha256::digest(SCRIPT)));
    write_once(&path, SCRIPT).await?;
    Ok(path)
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
    let (suggested, maximum, headroom) =
        budget_limits(cpus, total, value("SwapTotal:").unwrap_or(0));
    let identity = tokio::fs::read_to_string("/etc/machine-id").await?;
    let boot = tokio::fs::read_to_string("/proc/sys/kernel/random/boot_id").await?;
    let name = tokio::fs::read_to_string("/proc/sys/kernel/hostname")
        .await?
        .trim()
        .to_owned();
    Ok(
        json!({"id":format!("local-{:x}",Sha256::digest(identity.trim().as_bytes())),"name":name,"bootId":boot.trim(),
        "memoryTotalMiB":total,"memoryAvailableMiB":value("MemAvailable:"),"swapTotalMiB":value("SwapTotal:"),"swapFreeMiB":value("SwapFree:"),"logicalCpus":cpus,
        "suggestedBudget":suggested,"maximumBudget":maximum,
        "hostHeadroomMiB":headroom,
        "scope":"Only jobs managed by this Core share this budget. CPU is a quota, not physical-core reservation. WSL shares host RAM with Windows; other applications are outside this budget."}),
    )
}
// Defaults stay conservative; explicit configuration may use more of a larger
// host. Keep at least a quarter of CPU quota and half of RAM outside this
// Core's budget. Admission also checks current available RAM with headroom.
pub(super) fn budget_limits(
    cpus: u64,
    total: u64,
    swap: u64,
) -> (super::Resources, super::Resources, u64) {
    let headroom = (total / 16).clamp(128, 2048);
    let maximum = super::Resources {
        cpu_millis: cpus.saturating_mul(750),
        memory_mi_b: (total / 2).min(total.saturating_sub(headroom)),
        swap_mi_b: swap.min(total) / 4,
    };
    let suggested = super::Resources {
        cpu_millis: cpus
            .saturating_mul(500)
            .clamp(200, 4000)
            .min(maximum.cpu_millis),
        memory_mi_b: (total / 4).min(8192).min(maximum.memory_mi_b),
        swap_mi_b: 0,
    };
    (suggested, maximum, headroom)
}
fn folder(data: &Path, job: &Value) -> Result<PathBuf> {
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
            json!({"jobId":job["id"],"attempt":job["attempt"],"status":"running","reason":"Running with verified cgroup limits","started":proof,"evidence":state["systemd"],"freezer":state["freezer"]}),
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
pub(super) async fn usage(data: &Path, job: &Value) -> Result<Value> {
    if job["reserved"] != true {
        return Ok(Value::Null);
    }
    let script = helper(data).await?;
    let spec = folder(data, job)?.join("spec.json");
    if !tokio::fs::try_exists(&spec).await? {
        return Ok(Value::Null);
    }
    invoke(&script, "inspect", Some(&spec), None).await
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
