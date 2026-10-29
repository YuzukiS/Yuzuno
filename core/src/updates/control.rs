//! Private local control channel. Not an HTTP API and never accepts executable
//! paths, shell text, remote URLs, process IDs or database paths from a client.
use super::{
    controller::Controller,
    state::{self, Phase, ProcessIdentity},
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};
use subtle::ConstantTimeEq;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixListener,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Command {
    Inspect,
    Seal,
    Stop,
    Restore,
    Finish,
    Abort,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    pub operation_id: String,
    pub token: String,
    pub command: Command,
}

pub fn listen(controller: Arc<Controller>) -> Result<()> {
    let (layout, _) = controller.managed()?;
    let socket = layout.socket();
    if socket.exists() {
        // The process bound its exclusive HTTP port and Workspace lock before
        // this function. A stale socket is not proof of a live update server.
        ensure!(
            std::os::unix::net::UnixStream::connect(&socket).is_err(),
            "An update control server is already listening"
        );
        std::fs::remove_file(&socket)?;
    }
    let listener = UnixListener::bind(&socket)
        .context("Cannot bind private update socket (managed path may be too long)")?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let this = controller.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut reader = BufReader::new(read);
                let mut line = vec![];
                // JSON contains only a UUID, secret, and command. Bound both
                // allocation and elapsed time even on this owner-only socket.
                let incoming = tokio::time::timeout(Duration::from_secs(5), async {
                    loop {
                        let available = reader.fill_buf().await?;
                        ensure!(!available.is_empty(), "Incomplete update command");
                        let count = available
                            .iter()
                            .position(|b| *b == b'\n')
                            .map_or(available.len(), |n| n + 1);
                        ensure!(line.len() + count <= 4096, "Update command too large");
                        line.extend_from_slice(&available[..count]);
                        reader.consume(count);
                        if line.last() == Some(&b'\n') {
                            break;
                        }
                    }
                    Ok::<Request, anyhow::Error>(serde_json::from_slice(&line)?)
                })
                .await;
                let stopping = matches!(&incoming, Ok(Ok(request)) if matches!(request.command, Command::Stop));
                let response = match incoming {
                    Ok(Ok(request)) => match dispatch(&this, request).await {
                        Ok(value) => json!({"ok":true,"value":value}),
                        Err(error) => json!({"ok":false,"error":format!("{error:#}")}),
                    },
                    _ => json!({"ok":false,"error":"Invalid update control request"}),
                };
                if let Ok(mut bytes) = serde_json::to_vec(&response) {
                    bytes.push(b'\n');
                    let _ =
                        tokio::time::timeout(Duration::from_secs(5), write.write_all(&bytes)).await;
                    if stopping && response["ok"] == true {
                        this.shutdown.send_replace(true);
                    }
                }
            });
        }
    });
    Ok(())
}

pub(super) async fn dispatch(this: &Controller, request: Request) -> Result<Value> {
    let (layout, running) = this.managed()?;
    let op = layout.journal()?.operation.context("No update operation")?;
    ensure!(
        op.id == request.operation_id
            && bool::from(op.token.as_bytes().ct_eq(request.token.as_bytes())),
        "Update control authentication failed"
    );
    if matches!(request.command, Command::Inspect) {
        return Ok(
            json!({"process":ProcessIdentity::read(std::process::id())?,"releaseId":running.manifest.release_id,
            "workspaceId":this.runtime_read(|runtime| runtime.workspace_id()).await?,"health":this.runtime_read(|runtime| runtime.health()).await?,
            "blockers":this.blockers().await?,"phase":op.phase,"sealed":this.admission.snapshot().sealed}),
        );
    }
    let _transition = tokio::time::timeout(Duration::from_secs(5), this.transition.lock())
        .await
        .context("Another update transition is still finishing")?;
    let op = layout.journal()?.operation.context("No update operation")?;
    ensure!(op.id == request.operation_id, "Update operation changed");
    // A socket timeout alone does not cancel the server-side operation. Bound
    // each transition here so a stuck consumer cannot own this lock forever.
    let budget = match request.command {
        Command::Restore => 180,
        Command::Abort => 120,
        _ => 60,
    };
    tokio::time::timeout(Duration::from_secs(budget), execute(this, request))
        .await
        .context(
            "Update transition timed out; its durable phase will be reconciled before further work",
        )?
}

async fn execute(this: &Controller, request: Request) -> Result<Value> {
    let (layout, running) = this.managed()?;
    let op = layout.journal()?.operation.context("No update operation")?;
    match request.command {
        Command::Inspect => unreachable!(),
        Command::Seal => {
            ensure!(op.phase == Phase::Waiting, "Update is no longer waiting");
            ensure!(
                chrono::DateTime::parse_from_rfc3339(&op.deadline)? > chrono::Utc::now(),
                "Update wait expired"
            );
            ensure!(
                op.old_process == ProcessIdentity::read(std::process::id())?,
                "Original Core process changed"
            );
            if !this.blockers().await?.is_empty() {
                return Ok(json!({"sealed":false}));
            }
            this.runtime.flush().await?;
            if !this.blockers().await?.is_empty() || !this.admission.try_seal(&op.id)? {
                return Ok(json!({"sealed":false}));
            }
            let sessions = this.runtime_read(|runtime| runtime.sessions()).await?;
            layout.edit_operation(&op.id, |op| {
                op.total_sessions = sessions.len();
                op.sessions = sessions;
                op.set_phase(Phase::Flushing, None);
                Ok(())
            })?;
            // Native connections are idle now; detach releases their writer
            // leases without closing Agents or changing native session IDs.
            this.runtime.detach().await?;
            this.admission.wait_quiescent().await;
            this.runtime.flush().await?;
            ensure!(
                this.blockers().await?.is_empty() && this.admission.try_seal(&op.id)?,
                "Native work arrived during final flush"
            );
            Ok(json!({"sealed":true,"health":this.runtime_read(|runtime| runtime.health()).await?}))
        }
        Command::Stop => {
            ensure!(
                matches!(
                    op.phase,
                    Phase::Flushing | Phase::Starting | Phase::Restoring
                ),
                "Core cannot stop in this update phase"
            );
            // The running Core stops only while a Core can still start where
            // it did (T-11). Refused, it stays Flushing, and the helper's
            // Abort gives it back its sessions and work. A candidate that
            // failed (Starting, Restoring) is stopped whatever its directory.
            if op.phase == Phase::Flushing {
                op.launch
                    .check_cwd()
                    .context("Before stopping the running Core: it was not stopped")?;
            }
            ensure!(
                this.admission.snapshot().operation_id.as_deref() == Some(&op.id)
                    && this.blockers().await?.is_empty(),
                "Core still has accepted work"
            );
            ensure!(
                this.admission.try_seal(&op.id)?,
                "Accepted requests are still finishing"
            );
            this.runtime.detach().await?;
            this.admission.wait_quiescent().await;
            this.runtime.flush().await?;
            ensure!(
                this.blockers().await?.is_empty() && this.admission.try_seal(&op.id)?,
                "Native writers have not finished"
            );
            layout.edit_operation(&op.id, |op| {
                op.phase = Phase::Stopping;
                op.stopping_process = Some(ProcessIdentity::read(std::process::id())?);
                op.updated_at = state::now();
                Ok(())
            })?;
            Ok(json!({"stopping":true}))
        }
        Command::Restore => {
            ensure!(
                matches!(op.phase, Phase::Starting | Phase::Restoring),
                "Core is not ready to restore sessions"
            );
            ensure!(
                this.admission.snapshot().operation_id.as_deref() == Some(&op.id),
                "New-work admission is not closed"
            );
            layout.edit_operation(&op.id, |op| {
                op.phase = Phase::Restoring;
                op.updated_at = state::now();
                Ok(())
            })?;
            let restored = this.runtime.restore(&op.sessions).await?;
            layout.edit_operation(&op.id, |op| {
                op.recovered_sessions = restored;
                op.updated_at = state::now();
                Ok(())
            })?;
            Ok(
                json!({"restored":restored,"health":this.runtime_read(|runtime| runtime.health()).await?}),
            )
        }
        Command::Finish => {
            ensure!(
                op.records_proof
                    .as_ref()
                    .is_some_and(|proof| proof["recordsReady"] == true
                        && proof["phase"] == "afterRestore"
                        && proof["releaseId"] == running.manifest.release_id
                        && proof["workspaceId"] == op.workspace_id),
                "This release has no fresh post-restore records proof"
            );
            ensure!(
                op.phase == Phase::Restoring && op.recovered_sessions == op.total_sessions,
                "Session restoration has not completed"
            );
            ensure!(
                this.runtime_read(|runtime| runtime.workspace_id()).await? == op.workspace_id,
                "Workspace identity changed"
            );
            let _health = this.runtime_read(|runtime| runtime.health()).await?;
            let current = super::state::ReleaseRef::from(running);
            ensure!(
                current.release_id == op.candidate.release_id
                    || current.release_id == op.previous.release_id,
                "Unexpected running release"
            );
            super::package::atomic_json(&layout.root.join("current.json"), &current)?;
            layout.edit(|j| {
                let op = j.operation.as_mut().context("Missing operation")?;
                ensure!(op.id == request.operation_id, "Update changed");
                op.phase = if current.release_id == op.candidate.release_id {
                    Phase::Complete
                } else {
                    Phase::RolledBack
                };
                op.updated_at = state::now();
                j.prepared = None;
                Ok(())
            })?;
            this.admission.reopen(&op.id)?;
            Ok(json!({"complete":true,"releaseId":current.release_id}))
        }
        Command::Abort => {
            ensure!(
                matches!(op.phase, Phase::Waiting | Phase::Flushing),
                "Cannot reopen a Core after switching began"
            );
            this.reopen_after_failure(
                &op,
                "Update did not proceed; the current Core remains available",
                Duration::from_secs(90),
            )
            .await?;
            Ok(json!({"reopened":true}))
        }
    }
}
