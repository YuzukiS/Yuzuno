use super::{
    admission::Admission,
    package::{self, Bundle, Catalog, CatalogEntry, STORAGE},
    state::{
        Journal, Launch, Layout, Operation, Phase, ProcessIdentity, ReleaseRef, SessionRef,
        KEEP_RELEASES, WAIT_SECONDS,
    },
};
use anyhow::{ensure, Context, Result};
use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    path::Path,
    sync::Arc,
};
use tokio::sync::{watch, Mutex};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    pub agent_id: Option<String>,
    pub name: String,
    pub reason: String,
}

/// The only bridge into Workspace's persistence/native-session lifecycle. The
/// admission gate must also wrap every work-producing entrypoint in Workspace.
pub trait Runtime: Send + Sync {
    fn configure_update_notices(&self, _layout: &Layout) {}
    fn request_update_pause<'a>(&'a self, _operation: &'a Operation) -> BoxFuture<'a, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn update_pause_status(&self, _operation: &Operation) -> Result<Value> { Ok(json!([])) }
    fn workspace_id(&self) -> Result<String>;
    fn blockers(&self) -> Result<Vec<Blocker>>;
    fn sessions(&self) -> Result<Vec<SessionRef>>;
    fn health(&self) -> Result<Value>;
    fn flush(&self) -> BoxFuture<'_, Result<()>>;
    fn detach(&self) -> BoxFuture<'_, Result<()>>;
    fn restore<'a>(&'a self, sessions: &'a [SessionRef]) -> BoxFuture<'a, Result<usize>>;
}

pub struct Controller {
    pub releases: Arc<super::releases::Releases>,
    pub admission: Arc<Admission>,
    pub shutdown: watch::Sender<bool>,
    pub runtime: Arc<dyn Runtime>,
    pub layout: Option<Layout>,
    pub running: Option<Bundle>,
    pub launch: Launch,
    /// Serializes check/prepare/apply/cancel/seal within this Core. The journal's
    /// file lock also serializes the helper's cross-process phase transitions.
    pub transition: Mutex<()>,
    candidates: Mutex<Vec<(CatalogEntry, Bundle)>>,
    storage_cache: Mutex<Option<(std::time::Instant, Value)>>,
}

impl Controller {
    pub fn new(
        layout: Option<Layout>,
        running: Option<Bundle>,
        launch: Launch,
        runtime: Arc<dyn Runtime>,
        admission: Arc<Admission>,
    ) -> Result<Arc<Self>> {
        let (shutdown, _) = watch::channel(false);
        let controller = Arc::new(Self {
            releases: Arc::new(super::releases::Releases::new(layout.as_ref())),
            admission,
            shutdown,
            runtime,
            layout,
            running,
            launch,
            transition: Mutex::new(()),
            candidates: Mutex::new(vec![]),
            storage_cache: Mutex::new(None),
        });
        if let Some(layout) = &controller.layout {
            controller.runtime.configure_update_notices(layout);
            if let Some(op) = layout.journal()?.operation.filter(|o| o.phase.active()) {
                if op.phase == Phase::Preparing {
                    layout.edit_operation(&op.id, |op| { op.set_phase(Phase::Failed, Some("Preparation was interrupted by a Core restart; prepare the release again".into())); Ok(()) })?;
                    return Ok(controller);
                }
                // A managed replacement cannot accept new work until the helper
                // verifies release + Workspace health and restores the sessions.
                controller.admission.begin_drain(&op.id)?;
            }
        }
        Ok(controller)
    }

    pub fn managed(&self) -> Result<(&Layout, &Bundle)> {
        Ok((
            self.layout
                .as_ref()
                .context("This Core is a development checkout; managed updates are unavailable")?,
            self.running
                .as_ref()
                .context("Running release identity is unavailable")?,
        ))
    }

    /// Runtime reads can assemble records; keep them off Tokio workers.
    pub async fn runtime_read<T: Send + 'static>(
        &self,
        read: impl FnOnce(&dyn Runtime) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let runtime = self.runtime.clone();
        crate::db::blocking(move || read(runtime.as_ref())).await
    }

    pub async fn blockers(&self) -> Result<Vec<Blocker>> {
        let mut blockers = self.runtime_read(|runtime| runtime.blockers()).await?;
        let in_flight = self.admission.snapshot().in_flight;
        if in_flight != 0 {
            blockers.push(Blocker {
                agent_id: None,
                name: "Accepted requests".into(),
                reason: format!("{in_flight} request(s) finishing"),
            });
        }
        Ok(blockers)
    }

    pub async fn status(&self) -> Result<Value> {
        let (journal, storage) = if let Some(layout) = &self.layout {
            let mut cached = self.storage_cache.lock().await;
            if cached
                .as_ref()
                .is_none_or(|(at, _)| at.elapsed().as_secs() >= 30)
            {
                let layout = layout.clone();
                let measured =
                    tokio::task::spawn_blocking(move || storage_usage(&layout)).await??;
                *cached = Some((std::time::Instant::now(), measured));
            }
            (layout.journal()?, cached.as_ref().unwrap().1.clone())
        } else {
            (
                Journal::default(),
                json!({"releaseBytes":0,"backupBytes":0,"retainedReleases":0,"keepReleases":KEEP_RELEASES}),
            )
        };
        let current = self.running.as_ref().map(|b| summary(b, None)).unwrap_or_else(|| json!({
            "releaseId":"development","version":env!("CARGO_PKG_VERSION"),"gitSha":"","builtAt":"","platform":package::platform(),"protocol":package::PROTOCOL,"schema":{"writes":STORAGE,"readsMin":STORAGE,"readsMax":STORAGE},"records":{"writes":super::storage::RECORD_LAYOUT,"readsMin":super::storage::RECORD_LAYOUT,"readsMax":super::storage::RECORD_LAYOUT},"notes":"Development checkout","bytes":0
        }));
        let candidates = self
            .candidates
            .lock()
            .await
            .iter()
            .map(|(entry, bundle)| summary(bundle, Some(&entry.source)))
            .collect::<Vec<_>>();
        // Ordinary background polling must not deserialize every conversation.
        // Full blockers are needed only after an update has closed admission.
        let blockers = if self.admission.snapshot().operation_id.is_some() {
            self.blockers().await?
        } else {
            vec![]
        };
        let wait_notices = if let Some(op) = journal.operation.clone().filter(|op| op.phase == Phase::Waiting) {
            self.runtime_read(move |runtime| runtime.update_pause_status(&op)).await?
        } else { json!([]) };
        Ok(
            json!({"managed":self.running.is_some(),"reason":if self.running.is_none() {Some("This Core uses a development checkout. Install a managed release to enable updates here.")} else {None},
            "current":current,"candidates":candidates,"preparedReleaseId":journal.prepared.map(|p|p.release_id),"releaseSource":self.releases.status(),
            "operation":journal.operation.map(|o|o.public()),"blockers":blockers,"waitNotices":wait_notices,
            "acceptingWork":self.admission.snapshot().operation_id.is_none(),"storage":storage}),
        )
    }

    pub async fn check(&self) -> Result<()> {
        let _transition = self.transition.lock().await;
        self.refresh_catalog().await
    }
    async fn refresh_catalog(&self) -> Result<()> {
        let (layout, running) = self.managed()?;
        let layout = layout.clone();
        let running = running.clone();
        let candidates = tokio::task::spawn_blocking(move || -> Result<Vec<_>> {
            let path = layout.root.join("catalog.json");
            ensure!(
                fs::symlink_metadata(&path)?.file_type().is_file()
                    && fs::metadata(&path)?.len() < 1024 * 1024,
                "Invalid local release catalog"
            );
            let catalog: Catalog = serde_json::from_reader(File::open(path)?)?;
            ensure!(
                catalog.format == 1 && catalog.releases.len() <= 100,
                "Unsupported release catalog"
            );
            let mut seen = std::collections::HashSet::new();
            let mut candidates = vec![];
            for entry in catalog.releases {
                package::valid_id(&entry.release_id)?;
                ensure!(
                    seen.insert(entry.release_id.clone())
                        && !entry.reviewed_at.is_empty()
                        && !entry.source.is_empty(),
                    "Local catalog review metadata is missing or duplicated"
                );
                if entry.release_id == running.manifest.release_id {
                    continue;
                }
                let staged = layout.root.join("releases").join(&entry.release_id);
                let path = if staged.exists() {
                    staged
                } else {
                    layout.root.join("incoming").join(&entry.release_id)
                };
                let bundle = Bundle::verify(&path, &entry.manifest_sha256)?;
                ensure!(
                    bundle.manifest.release_id == entry.release_id,
                    "Catalog release ID differs from manifest"
                );
                bundle.compatible_with(&running.manifest, STORAGE)?;
                let built_at = chrono::DateTime::parse_from_rfc3339(&bundle.manifest.built_at)?;
                if built_at <= chrono::DateTime::parse_from_rfc3339(&running.manifest.built_at)? {
                    continue;
                }
                candidates.push((entry, bundle));
            }
            Ok(candidates)
        })
        .await??;
        *self.candidates.lock().await = candidates;
        Ok(())
    }

    async fn operation(
        &self,
        release: &Bundle,
        request_id: String,
        phase: Phase,
    ) -> Result<Operation> {
        let (_, running) = self.managed()?;
        let at = chrono::Utc::now();
        Ok(Operation {
            id: uuid::Uuid::new_v4().to_string(),
            request_id,
            release_id: release.manifest.release_id.clone(),
            phase,
            started_at: at.to_rfc3339(),
            updated_at: at.to_rfc3339(),
            deadline: (at + chrono::Duration::seconds(WAIT_SECONDS)).to_rfc3339(),
            error: None,
            recovered_sessions: 0,
            total_sessions: 0,
            previous: ReleaseRef::from(running),
            candidate: ReleaseRef::from(release),
            old_process: ProcessIdentity::read(std::process::id())?,
            helper_process: None,
            new_process: None,
            stopping_process: None,
            records_proof: None,
            workspace_id: self.runtime_read(|runtime| runtime.workspace_id()).await?,
            token: uuid::Uuid::new_v4().to_string(),
            launch: self.launch.clone(),
            sessions: vec![],
        })
    }

    /// The spawned task owns preparation after the accepting HTTP request ends.
    pub async fn prepare(self: &Arc<Self>, release_id: &str) -> Result<String> {
        let _transition = self.transition.lock().await;
        let (layout, _) = self.managed()?;
        ensure!(
            !layout
                .journal()?
                .operation
                .is_some_and(|o| o.phase.active()),
            "An update is already in progress"
        );
        self.refresh_catalog().await?;
        let bundle = self
            .candidates
            .lock()
            .await
            .iter()
            .find(|(_, b)| b.manifest.release_id == release_id)
            .map(|(_, b)| b.clone())
            .context("Release is not in the reviewed local catalog")?;
        let operation = self
            .operation(&bundle, String::new(), Phase::Preparing)
            .await?;
        let id = operation.id.clone();
        layout.edit(|j| {
            j.operation = Some(operation);
            Ok(())
        })?;
        let this = self.clone();
        let layout = layout.clone();
        let task_id = id.clone();
        tokio::spawn(async move {
            let destination = layout.root.join("releases");
            let reserve = database_size(&this.launch.data_dir)
                .unwrap_or(0)
                .saturating_mul(2)
                .saturating_add(64 * 1024 * 1024);
            let incoming = layout.root.join("incoming");
            let cleanup_layout = layout.clone();
            let cleanup_id = task_id.clone();
            let outcome = tokio::task::spawn_blocking(move || {
                let staged = bundle.stage(&destination, reserve)?;
                if bundle.path.parent() == Some(incoming.as_path()) {
                    fs::remove_dir_all(&bundle.path)?;
                }
                // Preparing many candidates without applying must still keep
                // storage bounded; preserve the running and prior prepared pair.
                super::helper::retain(&cleanup_layout, &cleanup_id)?;
                Ok::<_, anyhow::Error>(staged)
            })
            .await;
            let result = match outcome {
                Ok(result) => result,
                Err(error) => Err(error.into()),
            };
            let saved = layout.edit(|j| {
                let op = j
                    .operation
                    .as_mut()
                    .context("Preparation state disappeared")?;
                ensure!(
                    op.id == task_id && op.phase == Phase::Preparing,
                    "Preparation state changed"
                );
                match result {
                    Ok(bundle) => {
                        j.prepared = Some(ReleaseRef::from(&bundle));
                        op.set_phase(Phase::Prepared, None);
                    }
                    Err(error) => op.set_phase(
                        Phase::Failed,
                        Some(format!("Preparation failed: {error:#}")),
                    ),
                }
                Ok(())
            });
            if let Err(error) = saved {
                eprintln!("Cannot record update preparation: {error:#}");
            }
        });
        Ok(id)
    }

    pub async fn apply(self: &Arc<Self>, release_id: &str, request_id: &str) -> Result<String> {
        ensure!(
            uuid::Uuid::parse_str(request_id).is_ok(),
            "A stable update request ID is required"
        );
        let _transition = self.transition.lock().await;
        let (layout, _) = self.managed()?;
        let journal = layout.journal()?;
        if let Some((_, saved)) = journal.requests.iter().find(|(id, _)| id == request_id) {
            let (saved_release, operation_id) = saved
                .split_once('/')
                .context("Invalid update request receipt")?;
            ensure!(
                saved_release == release_id,
                "This request ID belongs to another release"
            );
            return Ok(operation_id.into());
        }
        ensure!(
            !journal.operation.is_some_and(|o| o.phase.active()),
            "An update is already in progress"
        );
        let prepared = journal
            .prepared
            .context("Prepare the release before applying")?;
        ensure!(
            prepared.release_id == release_id,
            "Prepared release differs from requested release"
        );
        // Complete bundles include the native SDK and may take seconds to
        // hash. Keep accepting events and serving status while verifying.
        let verify_layout = layout.clone();
        let candidate = crate::db::blocking(move || verify_layout.release(&prepared)).await?;
        let data = self.launch.data_dir.clone();
        let storage = crate::db::blocking(move || super::storage::Storage::at(&data)).await?;
        storage.readable_by(&candidate.manifest)?;
        storage.readable_by(&self.running.as_ref().unwrap().manifest)?;
        candidate.compatible_with(&self.running.as_ref().unwrap().manifest, STORAGE)?;
        package::ensure_space(
            &layout.root,
            database_size(&self.launch.data_dir)?
                .saturating_mul(2)
                .saturating_add(64 * 1024 * 1024),
        )?;
        let op = self
            .operation(&candidate, request_id.into(), Phase::Waiting)
            .await?;
        let id = op.id.clone();
        self.admission.begin_drain(&id)?;
        let accepted = layout.edit(|j| {
            j.requests
                .push((request_id.into(), format!("{release_id}/{id}")));
            j.operation = Some(op.clone());
            Ok(())
        });
        if let Err(error) = accepted {
            self.admission.reopen(&id)?;
            return Err(error);
        }
        // Persist the original active Turn targets before the helper can seal.
        // Notice failure does not impersonate idle or prevent cancellation.
        if let Err(error) = self.runtime.request_update_pause(&op).await {
            eprintln!("Update pause notification: {error:#}");
        }
        if let Err(error) = super::helper::spawn(self, &id) {
            let saved = layout.edit_operation(&id, |op| {
                op.set_phase(
                    Phase::Failed,
                    Some(format!("Update helper could not start: {error:#}")),
                );
                Ok(())
            });
            self.admission.reopen(&id)?;
            saved?;
            return Err(error);
        }
        Ok(id)
    }

    pub async fn cancel(&self, id: &str) -> Result<()> {
        let _transition = self.transition.lock().await;
        let (layout, _) = self.managed()?;
        layout.edit_operation(id, |op| {
            if op.phase == Phase::Cancelled {
                return Ok(());
            }
            ensure!(
                op.phase == Phase::Waiting,
                "The update has already begun switching and cannot be cancelled"
            );
            op.set_phase(Phase::Cancelled, None);
            Ok(())
        })?;
        if self.admission.snapshot().operation_id.as_deref() == Some(id) {
            self.admission.reopen(id)?;
        }
        Ok(())
    }

    /// A dead helper must not leave the workspace permanently draining. This
    /// recovery runs in Core, independent of a browser tab polling status.
    pub fn monitor(self: &Arc<Self>) {
        if self.layout.is_none() {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let Some(this) = weak.upgrade() else {
                    break;
                };
                if *this.shutdown.borrow() {
                    break;
                }
                if let Err(error) = this.recover_abandoned_operation().await {
                    eprintln!("Update recovery: {error:#}");
                }
            }
        });
    }

    pub(super) async fn recover_abandoned_operation(&self) -> Result<()> {
        let _transition = self.transition.lock().await;
        let (layout, _) = self.managed()?;
        let Some(op) = layout.journal()?.operation else {
            return Ok(());
        };
        if self.admission.snapshot().operation_id.as_deref() != Some(&op.id) {
            return Ok(());
        }
        let expired = op.phase == Phase::Waiting
            && chrono::DateTime::parse_from_rfc3339(&op.deadline)? <= chrono::Utc::now();
        let started = chrono::DateTime::parse_from_rfc3339(&op.started_at)?;
        let abandoned = op.helper_process.as_ref().is_none_or(|p| !p.alive())
            && chrono::Utc::now()
                .signed_duration_since(started)
                .num_seconds()
                > 15;
        if !(expired || abandoned) {
            return Ok(());
        }
        let me = ProcessIdentity::read(std::process::id())?;
        // Stop may belong to the original Core OR the failed candidate. Never
        // reopen a process whose acknowledged Stop is still finishing.
        if op.phase == Phase::Stopping
            && (op.stopping_process.as_ref() == Some(&me)
                || (op.stopping_process.is_none()
                    && (op.old_process == me || op.new_process.as_ref() == Some(&me))))
        {
            return Ok(());
        }
        if op
            .helper_process
            .as_ref()
            .is_some_and(ProcessIdentity::alive)
        {
            return Ok(());
        }
        // Shares the helper's exclusive lease. Its death check alone has a
        // race with helper startup; hold this through restoration and reopen.
        let lease = super::state::private_file(&layout.updates().join("helper.lock"))?;
        match lease.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        let latest = layout.journal()?.operation.context("Update disappeared")?;
        if latest.id != op.id
            || latest.phase != op.phase
            || latest
                .helper_process
                .as_ref()
                .is_some_and(ProcessIdentity::alive)
        {
            return Ok(());
        }
        let reason = if expired {
            "Update wait timed out; no active turn was stopped"
        } else if op.phase == Phase::Stopping {
            "Update switching was interrupted; the restarted Core restored this Workspace"
        } else {
            "Update helper exited; this Core is available again"
        };
        self.reopen_after_failure(&op, reason, std::time::Duration::from_secs(180))
            .await
    }

    /// Best-effort restore never traps the whole Workspace behind a failed
    /// update. Persist the failure when possible, then reopen even on disk full.
    pub(super) async fn reopen_after_failure(
        &self,
        op: &Operation,
        reason: &str,
        budget: std::time::Duration,
    ) -> Result<()> {
        let (layout, running) = self.managed()?;
        let restored = if matches!(
            op.phase,
            Phase::Flushing | Phase::Stopping | Phase::Starting | Phase::Restoring | Phase::Failed
        ) {
            tokio::time::timeout(budget, self.runtime.restore(&op.sessions))
                .await
                .map_err(anyhow::Error::from)
                .and_then(|r| r)
        } else {
            Ok(op.recovered_sessions)
        };
        // The actual packaged executable is verified on every boot. Recording
        // it avoids a later restart following a stale pointer after recovery.
        let receipt = package::atomic_json(
            &layout.root.join("current.json"),
            &ReleaseRef::from(running),
        );
        let recovered = restored.as_ref().ok().copied();
        let cause = op
            .error
            .as_ref()
            .map_or_else(|| reason.to_owned(), |error| format!("{reason}. {error}"));
        let message = match restored {
            Ok(_) => cause,
            Err(error) => format!("{cause}. Reconnect affected sessions manually: {error:#}"),
        };
        // Reopen even if the disk has become full and the error receipt cannot
        // be persisted; fail visibly instead of stranding the admission lock.
        let saved = layout.edit_operation(&op.id, |op| {
            if let Some(count) = recovered {
                op.recovered_sessions = count;
            }
            op.set_phase(Phase::Failed, Some(message));
            Ok(())
        });
        self.admission.reopen(&op.id)?;
        receipt.and(saved)
    }
}

fn summary(bundle: &Bundle, source: Option<&str>) -> Value {
    let m = &bundle.manifest;
    json!({"releaseId":m.release_id,"version":m.version,"gitSha":m.git_sha,"builtAt":m.built_at,
        "platform":m.platform,"protocol":m.protocol,"schema":m.schema,"records":m.records,"notes":m.notes,"bytes":bundle.total_bytes().unwrap_or(0),"source":source})
}
pub fn directory_bytes(root: &Path) -> Result<u64> {
    let mut total = 0u64;
    for entry in fs::read_dir(root)? {
        let entry = entry?;
        let meta = entry.metadata()?;
        ensure!(
            !entry.file_type()?.is_symlink(),
            "Managed storage contains a symlink"
        );
        total = total.saturating_add(if meta.is_dir() {
            directory_bytes(&entry.path())?
        } else {
            meta.len()
        });
    }
    Ok(total)
}
pub fn database_size(data: &Path) -> Result<u64> {
    // Include WAL, but do not count unrelated artifacts or copy authentication.
    let mut size = 0u64;
    for entry in fs::read_dir(data)? {
        let entry = entry?;
        if entry.file_name().to_string_lossy().contains("sqlite") {
            size = size.saturating_add(entry.metadata()?.len());
        }
    }
    Ok(size)
}
fn storage_usage(layout: &Layout) -> Result<Value> {
    let releases = layout.root.join("releases");
    let count = fs::read_dir(&releases)?
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_dir())
                && !e.file_name().to_string_lossy().starts_with('.')
        })
        .count();
    Ok(
        json!({"releaseBytes":directory_bytes(&releases)?.saturating_add(directory_bytes(&layout.root.join("incoming"))?),"backupBytes":directory_bytes(&layout.root.join("backups"))?,"retainedReleases":count,"keepReleases":KEEP_RELEASES}),
    )
}
