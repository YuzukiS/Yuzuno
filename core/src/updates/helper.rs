//! External one-operation helper. It owns no general service supervision and
//! can only switch the already-reviewed releases recorded by its running Core.
use super::{
    control::{Command as Control, Request},
    controller::Controller,
    package::{self, Bundle},
    state::{self, Layout, Operation, Phase, ProcessIdentity, ReleaseRef},
};
use anyhow::{bail, ensure, Context, Result};
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    path::Path,
    process::{Child, Command, Stdio},
    sync::Arc,
    time::{Duration, Instant},
};

pub fn spawn(controller: &Arc<Controller>, id: &str) -> Result<()> {
    let (layout, running) = controller.managed()?;
    prune_logs(layout, id)?;
    let log = state::private_file(&layout.updates().join(format!("{id}.helper.log")))?;
    let mut command = Command::new(running.path.join("bin/yuzuno-update-helper"));
    command
        .args(["run", "--install-dir"])
        .arg(&layout.root)
        .args(["--operation", id])
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    // Survive both the Core's exit and the terminal/window that launched Core.
    // No shell, arbitrary argument vector or PID is accepted from HTTP.
    unsafe {
        command.pre_exec(|| {
            rustix::process::setsid()
                .map(|_| ())
                .map_err(std::io::Error::from)
        });
    }
    let mut child = command
        .spawn()
        .context("Cannot launch packaged update helper")?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

pub fn call(layout: &Layout, op: &Operation, command: Control, timeout: Duration) -> Result<Value> {
    control_exchange(layout, op, command, timeout)
        .with_context(|| format!("Update operation {}: {command:?} control exchange failed", op.id))
}

fn control_exchange(layout: &Layout, op: &Operation, command: Control, timeout: Duration) -> Result<Value> {
    let mut stream = UnixStream::connect(layout.socket()).context("Cannot connect to Core's update socket")?;
    stream.set_read_timeout(Some(timeout)).context("Cannot set update socket read timeout")?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).context("Cannot set update socket write timeout")?;
    let mut bytes = serde_json::to_vec(&Request {
        operation_id: op.id.clone(),
        token: op.token.clone(),
        command,
    })?;
    bytes.push(b'\n');
    stream.write_all(&bytes).context("Cannot write update control request")?;
    let mut response = Vec::new();
    let mut reader = BufReader::new(stream);
    loop {
        let available = reader.fill_buf().map_err(|error| {
            let message = if matches!(error.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) {
                format!("Timed out reading {command:?} response: no data within {timeout:?}; the Core may be busy or unresponsive. Check the Core log and retry after it is idle")
            } else {
                format!("Cannot read {command:?} response from Core")
            };
            anyhow::Error::new(error).context(message)
        })?;
        ensure!(
            !available.is_empty(),
            "Update control connection closed before its receipt"
        );
        let n = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |n| n + 1);
        ensure!(
            response.len() + n < 1024 * 1024,
            "Update control response too large"
        );
        response.extend_from_slice(&available[..n]);
        reader.consume(n);
        if response.last() == Some(&b'\n') {
            break;
        }
    }
    let response: Value = serde_json::from_slice(&response).context("Invalid update control response JSON")?;
    ensure!(
        response["ok"] == true,
        "{}",
        response["error"]
            .as_str()
            .unwrap_or("Update control command failed")
    );
    Ok(response["value"].clone())
}

pub fn run(root: &Path, operation_id: &str) -> Result<()> {
    let layout = Layout::open(root)?;
    let op = current(&layout, operation_id)?;
    ensure!(
        op.phase == Phase::Waiting,
        "This operation is not waiting to switch"
    );
    ensure!(
        op.old_process.alive(),
        "Original Core process identity no longer matches"
    );
    package::valid_id(&op.previous.release_id)?;
    let previous_path = layout.root.join("releases").join(&op.previous.release_id);
    ensure!(
        std::env::current_exe()? == previous_path.join("bin/yuzuno-update-helper"),
        "Helper must run from the original managed release"
    );
    ensure!(
        op.old_process.executable == previous_path.join("bin/yuzuno-workspace"),
        "Original Core executable differs from reviewed release"
    );
    layout.edit_operation(operation_id, |op| {
        op.helper_process = Some(ProcessIdentity::read(std::process::id())?);
        Ok(())
    })?;
    // Publish the exact live helper identity before bounded lock wait or large
    // package hashes. Otherwise Core can mistake a live startup for abandonment.
    // No switching is allowed until the exclusive lock and full verification.
    let result = (|| {
        let _lock = acquire_operation_lock(&layout, operation_id, Duration::from_secs(30))?;
        layout.release(&op.previous)?;
        perform(&layout, operation_id)
    })();
    if let Err(error) = &result {
        let current = current(&layout, operation_id)?;
        if matches!(current.phase, Phase::Waiting | Phase::Flushing) && current.old_process.alive()
        {
            layout.edit_operation(operation_id, |op| {
                op.error = Some(format!("Update stopped before switching: {error:#}"));
                Ok(())
            })?;
            if let Err(abort) = call(&layout, &current, Control::Abort, Duration::from_secs(180)) {
                eprintln!("Current Core recovery needs attention: {abort:#}");
            }
        } else if current.phase.active() {
            layout.edit_operation(operation_id, |op| {
                op.set_phase(
                    Phase::Failed,
                    Some(format!("Update needs manual recovery: {error:#}")),
                );
                Ok(())
            })?;
        }
    }
    result
}

/// Cancel reopens admission immediately. A new apply can therefore arrive
/// while the prior helper is still observing cancellation. It must yield its
/// lock before the new operation proceeds, without making a harmless retry
/// fail or allowing two helpers to switch the service.
pub(super) fn acquire_operation_lock(layout: &Layout, id: &str, budget: Duration) -> Result<File> {
    let lock = state::private_file(&layout.updates().join("helper.lock"))?;
    let deadline = Instant::now() + budget;
    loop {
        let op = current(layout, id)?;
        ensure!(
            op.phase == Phase::Waiting && op.old_process.alive(),
            "Update stopped waiting before its helper started"
        );
        match lock.try_lock() {
            Ok(()) => return Ok(lock),
            Err(std::fs::TryLockError::WouldBlock) => {}
            Err(error) => return Err(error.into()),
        }
        ensure!(
            Instant::now() < deadline,
            "Previous update helper did not release its lock in time"
        );
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn perform(layout: &Layout, id: &str) -> Result<()> {
    let initial = current(layout, id)?;
    // Reverify right before draining; staged files are not trusted merely
    // because their directory has a release-looking name.
    let candidate = layout.release(&initial.candidate)?;
    let previous = layout.release(&initial.previous)?;
    candidate.compatible_with(&previous.manifest, package::STORAGE)?;
    loop {
        let op = current(layout, id)?;
        if op.phase == Phase::Cancelled {
            return Ok(());
        }
        ensure!(
            op.phase == Phase::Waiting && op.old_process.alive(),
            "Original Core or operation changed while waiting"
        );
        ensure!(
            chrono::DateTime::parse_from_rfc3339(&op.deadline)? > chrono::Utc::now(),
            "Waiting for idle timed out; no process was stopped"
        );
        let status = call(layout, &op, Control::Inspect, Duration::from_secs(5))?;
        check_identity(&status, &op, &op.previous.release_id)?;
        if status["blockers"]
            .as_array()
            .is_some_and(|items| items.is_empty())
        {
            let sealed = call(layout, &op, Control::Seal, Duration::from_secs(90))?;
            if sealed["sealed"] == true {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(800));
    }
    let op = current(layout, id)?;
    verify_storage(layout, &op, &previous, "beforeStop")?;
    let storage = super::storage::Storage::at(&op.launch.data_dir)?;
    storage.readable_by(&candidate.manifest)?;
    storage.readable_by(&previous.manifest)?;
    backup(layout, &op)?;
    // Final checksum pass occurs while the old service still exists. Failure
    // can reopen that service; it never forces an unverified new executable.
    layout.release(&op.candidate)?;
    if let Err(error) = call(layout, &op, Control::Stop, Duration::from_secs(90)) {
        // The socket may close after the stop was durably accepted. Never
        // confuse a lost receipt with permission to replay or abandon a stop.
        ensure!(
            current(layout, id)?.phase == Phase::Stopping,
            "Core did not accept shutdown: {error:#}"
        );
    }
    wait_exit(&op.old_process, Duration::from_secs(20))?;
    let updated = boot_and_restore(layout, id, &candidate);
    match updated {
        Ok(()) => retain(layout, id),
        Err(error) => {
            let op = current(layout, id)?;
            // A lost Finish response is not a failed installation. The Core
            // persists completion before reopening admission to native work.
            if op.phase == Phase::Complete {
                return retain(layout, id);
            }
            ensure!(!op.new_process.as_ref().is_some_and(ProcessIdentity::alive), "Candidate still owns native sessions; leaving it running for recovery rather than stopping active or uncertain work. {error:#}");
            layout.edit_operation(id, |op| { op.error = Some(format!("Candidate could not become ready; restored the previous compatible release. {error:#}")); Ok(()) })?;
            let previous = layout.release(&op.previous)?;
            ensure!(
                previous
                    .manifest
                    .schema
                    .reads(candidate.manifest.schema.writes),
                "Old release cannot read the candidate schema; automatic rollback is forbidden"
            );
            super::storage::Storage::at(&op.launch.data_dir)?.readable_by(&previous.manifest)?;
            boot_and_restore(layout, id, &previous)
                .context("Compatible previous release also failed to become ready")?;
            retain(layout, id)
        }
    }
}

fn current(layout: &Layout, id: &str) -> Result<Operation> {
    let op = layout
        .journal()?
        .operation
        .context("Update state is missing")?;
    ensure!(op.id == id, "Update operation changed");
    Ok(op)
}

fn check_identity(status: &Value, op: &Operation, release: &str) -> Result<()> {
    ensure!(
        status["releaseId"] == release && status["workspaceId"] == op.workspace_id,
        "Release or Workspace identity differs"
    );
    ensure!(
        status["health"]["storageReady"] == true
            && status["health"]["apiReady"] == true
            && status["health"]["schema"] == package::STORAGE,
        "Workspace storage/API health is not ready"
    );
    Ok(())
}

fn wait_exit(process: &ProcessIdentity, timeout: Duration) -> Result<()> {
    let deadline = Instant::now() + timeout;
    while process.alive() {
        ensure!(
            Instant::now() < deadline,
            "Original Core has not exited; refusing to kill it or start another writer"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    Ok(())
}

pub(super) fn backup(layout: &Layout, op: &Operation) -> Result<()> {
    backup_with_budget(layout, op, Duration::from_secs(60))
}

pub(super) fn backup_with_budget(layout: &Layout, op: &Operation, budget: Duration) -> Result<()> {
    let database = op.launch.data_dir.join("workspace.sqlite");
    package::ensure_space(
        &layout.root,
        fs::metadata(&database)?
            .len()
            .saturating_mul(2)
            .saturating_add(64 * 1024 * 1024),
    )?;
    let destination = layout
        .root
        .join("backups")
        .join(format!("{}.sqlite3", op.id));
    ensure!(!destination.exists(), "Update backup already exists");
    state::private_file(&destination)?;
    let result = (|| -> Result<()> {
        let source = rusqlite::Connection::open_with_flags(
            database,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )?;
        source.busy_timeout(Duration::from_millis(100))?;
        let mut target = rusqlite::Connection::open(&destination)?;
        target.busy_timeout(Duration::from_millis(100))?;
        {
            let backup = rusqlite::backup::Backup::new(&source, &mut target)?;
            let deadline = Instant::now() + budget;
            loop {
                ensure!(
                    Instant::now() < deadline,
                    "Workspace backup timed out; no service was stopped"
                );
                match backup.step(128)? {
                    rusqlite::backup::StepResult::Done => break,
                    rusqlite::backup::StepResult::More => {}
                    _ => std::thread::sleep(Duration::from_millis(20)),
                }
            }
        }
        let check: String = target.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
        ensure!(check == "ok", "Workspace backup integrity check failed");
        target.close().map_err(|(_, error)| error)?;
        File::open(&destination)?.sync_all()?;
        // This backup is for manual recovery; rollback never restores it over DB.
        Ok(())
    })();
    if result.is_err() {
        // A failed backup is never a recovery candidate and must not accumulate
        // across failed attempts. The source database is never overwritten.
        let _ = fs::remove_file(&destination);
    }
    result
}

fn launch(layout: &Layout, op: &Operation, bundle: &Bundle) -> Result<Child> {
    let log = state::private_file(
        &layout
            .updates()
            .join(format!("{}.{}.core.log", op.id, bundle.manifest.release_id)),
    )?;
    let mut command = Command::new(bundle.path.join("bin/yuzuno-workspace"));
    command
        .arg("--install-dir")
        .arg(&layout.root)
        .arg("--port")
        .arg(op.launch.port.to_string())
        .arg("--data-dir")
        .arg(&op.launch.data_dir)
        .arg("--cwd")
        .arg(&op.launch.cwd)
        .arg("--codex")
        .arg(&op.launch.codex)
        .current_dir(&op.launch.cwd)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    command.spawn().context("Cannot start packaged Core")
}

fn boot_and_restore(layout: &Layout, id: &str, bundle: &Bundle) -> Result<()> {
    layout.edit_operation(id, |op| {
        op.phase = Phase::Starting;
        op.updated_at = state::now();
        op.new_process = None;
        op.stopping_process = None;
        op.records_proof = None;
        op.recovered_sessions = 0;
        Ok(())
    })?;
    let op = current(layout, id)?;
    let mut child = launch(layout, &op, bundle)?;
    let mut restore_started = false;
    let result = (|| -> Result<()> {
        let identity = ProcessIdentity::read(child.id())?;
        ensure!(
            identity.executable == bundle.path.join("bin/yuzuno-workspace"),
            "Candidate process executable differs"
        );
        layout.edit_operation(id, |op| {
            op.new_process = Some(identity.clone());
            Ok(())
        })?;
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()?;
        let deadline = Instant::now() + Duration::from_secs(45);
        loop {
            ensure!(
                child.try_wait()?.is_none(),
                "Candidate exited before becoming ready"
            );
            if let Ok(status) = call(layout, &op, Control::Inspect, Duration::from_secs(3)) {
                if check_identity(&status, &op, &bundle.manifest.release_id).is_ok()
                    && serde_json::from_value::<ProcessIdentity>(status["process"].clone())?
                        == identity
                {
                    let health = client
                        .get(format!("http://127.0.0.1:{}/api/health", op.launch.port))
                        .send()
                        .and_then(|response| response.error_for_status())
                        .and_then(|response| response.json::<Value>());
                    if health.is_ok_and(|health| {
                        health["releaseId"] == bundle.manifest.release_id
                            && health["workspaceId"] == op.workspace_id
                            && health["storageReady"] == true
                            && health["apiReady"] == true
                    }) {
                        break;
                    }
                }
            }
            ensure!(
                Instant::now() < deadline,
                "Candidate release/Workspace/storage health timed out"
            );
            std::thread::sleep(Duration::from_millis(250));
        }
        verify_storage(layout, &op, bundle, "beforeRestore")?;
        restore_started = true;
        call(layout, &op, Control::Restore, Duration::from_secs(240))?;
        verify_storage(layout, &op, bundle, "afterRestore")?;
        call(layout, &op, Control::Finish, Duration::from_secs(10))?;
        Ok(())
    })();
    if let Err(error) = &result {
        let latest = current(layout, id)?;
        if matches!(latest.phase, Phase::Complete | Phase::RolledBack) {
            return Ok(());
        }
        // Only this helper's newly spawned child is eligible. New Core boot
        // keeps admission closed until Finish, so no accepted work is killed.
        if child.try_wait()?.is_none() {
            let stopped = call(layout, &latest, Control::Stop, Duration::from_secs(90));
            if restore_started && stopped.is_err() {
                bail!("Candidate could not confirm idle shutdown after attaching sessions; it remains running. Original startup/restore error: {error:#}. Shutdown error: {:#}", stopped.unwrap_err());
            }
            let until = Instant::now() + Duration::from_secs(10);
            while child.try_wait()?.is_none() && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(100));
            }
            if child.try_wait()?.is_none() {
                ensure!(!restore_started, "Candidate shutdown is unconfirmed after restoring sessions; leaving its process running. Original startup/restore error: {error:#}");
                child.kill()?;
            }
        }
        child.wait()?;
    }
    result
}

const RECORDS_BUDGET: Duration = Duration::from_secs(120);

fn verify_storage(layout: &Layout, op: &Operation, bundle: &Bundle, phase: &str) -> Result<()> {
    // Explicitly discard any prior phase's proof before starting a new snapshot.
    layout.edit_operation(&op.id, |op| {
        op.records_proof = None;
        Ok(())
    })?;
    let mut command = Command::new(bundle.path.join("bin/yuzuno-update-helper"));
    command
        .arg("verify-records")
        .arg("--data-dir")
        .arg(&op.launch.data_dir)
        .arg("--workspace-id")
        .arg(&op.workspace_id);
    let mut proof = run_verifier(command, RECORDS_BUDGET)
        .with_context(|| format!("Update operation {}: {phase} records verification failed", op.id))?;
    ensure!(
        proof["recordsReady"] == true
            && proof["workspaceId"] == op.workspace_id
            && proof["schema"] == package::STORAGE,
        "Invalid storage verification receipt"
    );
    proof["releaseId"] = serde_json::json!(bundle.manifest.release_id);
    proof["phase"] = serde_json::json!(phase);
    proof["checkedAt"] = serde_json::json!(state::now());
    layout.edit_operation(&op.id, |op| {
        op.records_proof = Some(proof);
        Ok(())
    })
}

/// A stalled or very large record cannot occupy a Core worker, create a new
/// verifier every poll, or outlive the update budget. Only this read-only child
/// is killed, never a Core or native session. Pipes stay bounded by the child's
/// tiny JSON receipt; even unexpected output fills the pipe and times out.
pub(super) fn run_verifier(mut command: Command, budget: Duration) -> Result<Value> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .context("Cannot spawn workspace records verifier; check executable access and OS process/resource limits")?;
    let deadline = Instant::now() + budget;
    let result = (|| {
        let status = loop {
            if let Some(status) = child.try_wait()? {
                break status;
            }
            ensure!(
                Instant::now() < deadline,
                "Workspace records verification timed out; no readiness proof was accepted"
            );
            std::thread::sleep(Duration::from_millis(25));
        };
        let mut output = String::new();
        child
            .stdout
            .take()
            .context("Missing verifier output")?
            .take(65536)
            .read_to_string(&mut output)?;
        let mut error = String::new();
        child
            .stderr
            .take()
            .context("Missing verifier error")?
            .take(65536)
            .read_to_string(&mut error)?;
        ensure!(
            status.success(),
            "Workspace records verification failed: {error}"
        );
        Ok(serde_json::from_str(&output)?)
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    result
}

pub(super) fn retain(layout: &Layout, id: &str) -> Result<()> {
    let catalog_lock = state::private_file(&layout.updates().join("catalog.lock"))?;
    catalog_lock.lock()?;
    let op = current(layout, id)?;
    ensure!(
        matches!(
            op.phase,
            Phase::Preparing | Phase::Prepared | Phase::Complete | Phase::RolledBack
        ),
        "Retention requires preparation or a completed update"
    );
    let mut releases =
        fs::read_dir(layout.root.join("releases"))?.collect::<std::io::Result<Vec<_>>>()?;
    releases.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
    let mut protected = std::collections::HashSet::from([
        op.previous.release_id.clone(),
        op.candidate.release_id.clone(),
    ]);
    if let Some(prepared) = layout.journal()?.prepared {
        protected.insert(prepared.release_id);
    }
    let mut keep = protected.len();
    for entry in releases {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(staging_id) = name.strip_prefix(".stage-") {
            ensure!(
                uuid::Uuid::parse_str(staging_id).is_ok() && entry.file_type()?.is_dir(),
                "Unexpected interrupted release staging entry"
            );
            fs::remove_dir_all(entry.path())?;
            continue;
        }
        if protected.contains(&name) {
            continue;
        }
        package::valid_id(&name)?;
        ensure!(
            entry.file_type()?.is_dir(),
            "Unexpected retained release entry"
        );
        if keep < state::KEEP_RELEASES {
            keep += 1;
        } else {
            fs::remove_dir_all(entry.path())?;
        }
    }
    let mut backups =
        fs::read_dir(layout.root.join("backups"))?.collect::<std::io::Result<Vec<_>>>()?;
    backups.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
    for entry in backups.into_iter().skip(3) {
        ensure!(
            entry.file_type()?.is_file()
                && entry.path().extension().is_some_and(|e| e == "sqlite3"),
            "Unexpected backup entry"
        );
        fs::remove_file(entry.path())?;
    }
    let catalog_path = layout.root.join("catalog.json");
    let mut catalog: package::Catalog = serde_json::from_reader(File::open(&catalog_path)?)?;
    catalog.releases.retain(|r| {
        layout.root.join("releases").join(&r.release_id).is_dir()
            || layout.root.join("incoming").join(&r.release_id).is_dir()
    });
    package::atomic_json(&catalog_path, &catalog)?;
    prune_logs(layout, id)
}

pub(super) fn prune_logs(layout: &Layout, id: &str) -> Result<()> {
    let live_log = fs::read_link("/proc/self/fd/1").ok();
    let mut logs = fs::read_dir(layout.updates())?
        .filter_map(std::result::Result::ok)
        .filter(|e| {
            e.path().extension().is_some_and(|ext| ext == "log")
                && !e.file_name().to_string_lossy().starts_with(id)
                && live_log.as_ref() != Some(&e.path())
        })
        .collect::<Vec<_>>();
    logs.sort_by_key(|e| std::cmp::Reverse(e.metadata().and_then(|m| m.modified()).ok()));
    for entry in logs.into_iter().skip(6) {
        ensure!(entry.file_type()?.is_file(), "Unexpected update log entry");
        fs::remove_file(entry.path())?;
    }
    Ok(())
}

/// Resolve the actual executable, not an ambient version or source checkout.
pub fn running_bundle(layout: &Layout) -> Result<Bundle> {
    let executable = std::env::current_exe()?;
    let installed: ReleaseRef =
        serde_json::from_reader(File::open(layout.root.join("current.json"))?)?;
    let mut accepted = vec![installed];
    if let Some(op) = layout.journal()?.operation.filter(|op| op.phase.active()) {
        accepted.extend([op.previous, op.candidate]);
    }
    for release in accepted {
        if executable
            == layout
                .root
                .join("releases")
                .join(&release.release_id)
                .join("bin/yuzuno-workspace")
        {
            let bundle = layout.release(&release)?;
            packaged_storage(&bundle.manifest)?;
            return Ok(bundle);
        }
    }
    bail!("Core executable is outside the managed, reviewed release paths")
}

/// Whether a release's manifest says the storage this executable has: the
/// schema it writes, and the one records layout it writes and reads (ADR
/// 0002), as tools/package-release.py packages it.
pub(crate) fn packaged_storage(manifest: &package::Manifest) -> Result<()> {
    let layout = super::storage::RECORD_LAYOUT;
    ensure!(
        manifest.schema.writes == package::STORAGE
            && manifest.records.writes == layout
            && manifest.records.reads_min == layout
            && manifest.records.reads_max == layout,
        "Packaged storage capabilities differ from this executable"
    );
    Ok(())
}
