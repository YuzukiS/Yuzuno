use crate::{
    model::{ensure_agent_open, now, Agent, AgentDetail, AgentSettings, MessageInput, MessageReceipt, PendingRequest, RemoteAgent, ReviewTarget, SkillRef},
    rpc::{OutcomeUnknown, Rpc, RpcError},
    store::Store,
    remote,
    permissions::{self, Permissions},
};
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock,
    },
};
use tokio::sync::{mpsc, Mutex, Notify, OwnedMutexGuard};

#[cfg(test)]
#[path = "codex_context_native.rs"]
mod context_native_tests;

#[derive(Clone)]
pub(crate) struct Connection {
    pub(crate) generation: u64,
    pub(crate) rpc: Arc<Rpc>,
    pub(crate) closing: bool,
    pub(crate) events: Option<Arc<crate::updates::events::EventBarrier>>,
    pub(crate) attachment: Arc<Mutex<Option<Attachment>>>,
}

/// Frozen context of the one native attach sent on this connection. Its reply
/// and original snapshot boundary survive an HTTP timeout and later checks.
pub(crate) struct Attachment {
    agent: Agent,
    before: AgentDetail,
    request_seq: i64,
    request_rev: u64,
    imported: bool,
    new_empty_thread: bool,
    replacing_empty_thread: bool,
    same_thread_only: bool,
    initial_params: Value,
    reply: crate::rpc::PendingReply,
}

/// Locks, outermost first. Taking them in this order (and never the reverse)
/// is what keeps them deadlock-free:
///
/// 1. `gate(id)`: one lifecycle operation per Agent (send, reconnect, close,
///    settings, replies to requests). Held across native requests, which is
///    why native events must never wait for it: the transport stops reading
///    responses while its event queue is full.
/// 2. `owner(id)`: the Agent's connection ownership. A connection's
///    generation is checked and the store change it guards is made under it,
///    so an event of a replaced connection is never recorded after the
///    replacement. Every insert into or removal from `rpcs`/`claudes` for that
///    Agent happens under it as well. Held only across store work, never
///    across a native request or response, and never two Agents' at once. It
///    is per Agent, so one Agent's slow event never delays another's.
/// 3. `rpcs` / `claudes`: lookups only; std locks, never held across `.await`.
/// 4. Store's own: the Agent's record lock, then one SQLite connection (the
///    single writer or a reader), then its in-memory state (see `store::Store`
///    and `db`).
///
/// Operations assume they run to completion once started: store work is
/// awaited, and a write is often followed by the native request it records
/// (or the reverse). The HTTP layer therefore runs every API request in its
/// own task (`server::run_to_completion`); every other caller is a spawned
/// task, and a collaboration call is a single store job.
pub struct Workspace {
    pub(crate) codex_context: crate::codex_context::State,
    /// What each Codex Agent's MCP servers reported as they started (T-29).
    pub(crate) codex_mcp: crate::codex_mcp::State,
    /// Each Codex Agent's working-folder diff read and its streamed output (T-29).
    pub(crate) codex_diff: crate::codex_diff::State,
    /// Each Codex Agent's background terminal stop in progress (T-29 /stop).
    pub(crate) codex_terminals: crate::codex_terminals::State,
    /// The collaboration mode each Codex Agent's connection reported (T-29).
    pub(crate) codex_plan: crate::codex_plan::State,
    pub(crate) github: crate::github::SyncState,
    pub(crate) pr_reviews: crate::pr_review::State,
    pub(crate) pr_operations: crate::pr_operations::State,
    pub(crate) jobs: crate::jobs::State,
    pub(crate) ci: crate::ci_monitor::State,
    pub(crate) codex_usage: crate::codex_usage::State,
    pub(crate) delivery: crate::delivery::State,
    pub admission: Arc<crate::updates::admission::Admission>,
    pub(crate) update_notice_layout: OnceLock<crate::updates::state::Layout>,
    pub store: Arc<Store>,
    /// Live changes for clients (`/api/events`); see `events`.
    pub changes: Arc<crate::events::Events>,
    pub default_cwd: String,
    pub data_dir: PathBuf,
    pub runtime: Mutex<Value>,
    pub(crate) program: String,
    pub(crate) session_reads: tokio::sync::Semaphore,
    pub(crate) rpcs: std::sync::Mutex<HashMap<String, Connection>>,
    pub(crate) claudes: std::sync::Mutex<HashMap<String, crate::claude::Connection>>,
    pub(crate) opencodes: std::sync::Mutex<HashMap<String, crate::opencode_agent::Connection>>,
    pub(crate) claude_mcp: crate::claude_mcp::State,
    gates: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    owners: std::sync::Mutex<HashMap<String, Arc<Mutex<()>>>>,
    pub(crate) next_generation: AtomicU64,
    #[cfg(test)]
    pub(crate) reconnect_timeout_ms: AtomicU64,
    /// Native events Core has received but not yet applied, per connection.
    pub(crate) backlogs: crate::backlog::Backlogs,
    pub(crate) collaboration_url: OnceLock<String>,
    pub(crate) collaboration_wakeup: Notify,
    pub(crate) collaboration_attached: Mutex<HashMap<String, crate::collaboration_credentials::Readiness>>,
    pub(crate) collaboration_epoch: String,
    pub(crate) collaboration_tunnels: Mutex<HashMap<String, tokio::process::Child>>,
    // The shutdown sender is dropped with Workspace; its listener holds only a Weak owner.
    pub(crate) collaboration_remote_listener: tokio::sync::OnceCell<(u16, tokio::sync::oneshot::Sender<()>)>,
    stream_ticker: OnceLock<()>,
    pub(crate) background_shells: crate::background_shells::Registry,
    /// Sub-agents' proposed file changes until their approval request arrives.
    pub(crate) child_changes: crate::subagents::ChildChanges,
    /// Checks results Agents publish; started on first use (see `results`).
    pub(crate) results: Arc<crate::results::Validator>,
    /// The turn-end Brief check's journal position (see `brief_turns`).
    pub(crate) brief_turns: crate::brief_turns::State,
    /// The previous Machine Load sample (see `machine_load`).
    pub(crate) machine_load: crate::machine_load::State,
    /// Project services opened in this Core (T-151); see `services`.
    pub(crate) services: crate::services::Runtime,
    /// Backups and restores made from Settings (T-192); see `workspace_backup::online`.
    pub(crate) backups: Arc<crate::workspace_backup::online::Backups>,
}

impl Workspace {
    pub fn new(data_dir: PathBuf, cwd: String, program: String) -> Result<Arc<Self>> {
        std::fs::create_dir_all(&data_dir)?;
        crate::claude_sdk::set_cache(&data_dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&data_dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let store = Arc::new(Store::open(&data_dir.join("workspace.sqlite"))?);
        store.rotate_collaboration_mcp_credentials()?;
        store.recover_pr_reviews()?;
        store.recover_pr_operations()?;
        Ok(Arc::new(Self {
            github: Default::default(),
            pr_reviews: Default::default(),
            pr_operations: Default::default(),
            jobs: Default::default(),
            ci: Default::default(),
            codex_usage: Default::default(),
            codex_context: Default::default(),
            codex_mcp: Default::default(),
            codex_diff: Default::default(),
            codex_terminals: Default::default(),
            codex_plan: Default::default(),
            delivery: Default::default(),
            admission: Arc::new(crate::updates::admission::Admission::default()),
            update_notice_layout: OnceLock::new(),
            store,
            changes: Arc::new(crate::events::Events::new()),
            default_cwd: cwd,
            backups: Arc::new(crate::workspace_backup::online::Backups::open(&data_dir)),
            data_dir,
            program,
            session_reads: tokio::sync::Semaphore::new(1),
            runtime: Mutex::new(json!({"connected":false})),
            rpcs: std::sync::Mutex::new(HashMap::new()),
            claudes: std::sync::Mutex::new(HashMap::new()),
            opencodes: std::sync::Mutex::new(HashMap::new()),
            claude_mcp: Default::default(),
            gates: Mutex::new(HashMap::new()),
            owners: std::sync::Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(1),
            #[cfg(test)]
            reconnect_timeout_ms: AtomicU64::new(45_000),
            backlogs: Default::default(),
            collaboration_url: OnceLock::new(),
            collaboration_wakeup: Notify::new(),
            collaboration_attached: Mutex::new(HashMap::new()),
            collaboration_epoch: uuid::Uuid::new_v4().to_string(),
            collaboration_tunnels: Mutex::new(HashMap::new()),
            collaboration_remote_listener: tokio::sync::OnceCell::new(),
            stream_ticker: OnceLock::new(),
            background_shells: Default::default(),
            child_changes: Default::default(),
            results: Arc::new(crate::results::Validator::from_env()),
            brief_turns: Default::default(),
            machine_load: Default::default(),
            services: Default::default(),
        }))
    }

    /// Whether the ticker below, which also runs heap maintenance, has started.
    pub(crate) fn stream_ticker_started(&self) -> bool {
        self.stream_ticker.get().is_some()
    }

    /// Streamed deltas are announced and written on this cadence instead of
    /// once per delta, and expired rewind previews freed. Started with the
    /// first stream or rewind preview; holds only a Weak owner.
    pub(crate) fn start_stream_ticker(self: &Arc<Self>) {
        if self.stream_ticker.set(()).is_err() { return; }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let Some(ws) = weak.upgrade() else { break };
                // perf-sse: their Items went out as they arrived. Announced
                // in the same blocking job as the writes.
                let tick = ws.clone();
                let permit = match ws.admission.enter_completion() { Ok(p) => p, Err(_) => continue };
                let ticked = crate::db::blocking(move || {
                    let _permit = permit;
                    let done = tick.store.stream_tick(crate::store::STREAM_WRITE_AFTER);
                    for id in &done.announce { tick.progressed(id); }
                    // Rewind previews no one can confirm any more keep a
                    // whole history each; freed here, before any reclaim.
                    crate::rewind::expire_previews();
                    // Large record copies may be freed yet stay resident in
                    // glibc. Reclaim outside Store locks and async workers,
                    // only once recent records are idle, with a process-wide
                    // time/size gate. Active streams skip it entirely.
                    if let Some(reclaim) = crate::heap::reclaim_if_idle(&tick.store, &tick.admission) {
                        eprintln!("Core heap maintenance: {}", serde_json::to_string(&reclaim).unwrap_or_default());
                    }
                    Ok(done.failed)
                }).await;
                match ticked {
                    Ok(failed) => for error in failed { eprintln!("Workspace streamed output not written yet: {error:#}"); },
                    Err(error) => eprintln!("Workspace streamed output not written yet: {error:#}"),
                }
            }
        });
    }

    /// Writes every Agent record that still has deferred events or streamed
    /// output only in memory (see store::deferred and store::ephemeral).
    /// Turn, request, status and connection events are always written when
    /// they arrive; this is for a controlled shutdown or restart.
    pub async fn flush_event_writes(&self) -> Result<()> {
        let tick = self.stored(|store| Ok(store.flush())).await?;
        for id in &tick.announce { self.progressed(id); }
        match tick.failed.into_iter().next() {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Store work for an async caller, on the blocking pool (see `db`).
    pub(crate) async fn stored<T: Send + 'static>(
        &self,
        job: impl FnOnce(&Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let store = self.store.clone();
        let permit = self.admission.enter_event();
        crate::db::blocking(move || { let _permit = permit; job(&store) }).await
    }

    /// Like `stored`, while `owned` is held. The guard goes with the job and is
    /// released only when it has finished, so a caller that stops waiting
    /// cannot let another event or reconnect in before this change commits.
    pub(crate) async fn stored_owned<T: Send + 'static>(
        &self,
        owned: OwnedMutexGuard<()>,
        job: impl FnOnce(&Store) -> Result<T> + Send + 'static,
    ) -> Result<T> {
        let store = self.store.clone();
        let permit = self.admission.enter_event();
        crate::db::blocking(move || {
            let _permit = permit;
            let _owned = owned;
            job(&store)
        })
        .await
    }

    pub(crate) async fn detail(&self, id: &str) -> Result<AgentDetail> {
        let id = id.to_owned();
        self.stored(move |store| store.detail(&id)).await
    }

    /// The Agent as listed, with its project as `detail` gives it: what a
    /// check of its state, or an answer with the Agent only, needs, without
    /// its history (T-140).
    pub(crate) async fn listed(&self, id: &str) -> Result<crate::model::Agent> {
        let id = id.to_owned();
        self.stored(move |store| {
            let mut agent = store.agent(&id)?;
            agent.project_id = store.agent_project(&id)?;
            Ok(agent)
        }).await
    }

    /// `Store::send_view` for an async caller: what a send checks, without
    /// copying a large record's Items.
    pub(crate) async fn send_view(&self, id: &str) -> Result<AgentDetail> {
        let id = id.to_owned();
        self.stored(move |store| store.send_view(&id)).await
    }

    /// `Store::update` for an async caller.
    pub(crate) async fn update_record(
        &self,
        id: &str,
        kind: &str,
        data: Value,
        mutate: impl FnOnce(&mut AgentDetail) + Send + 'static,
    ) -> Result<AgentDetail> {
        let (id, kind) = (id.to_owned(), kind.to_owned());
        self.stored(move |store| store.update(&id, &kind, &data, mutate)).await
    }

    /// `update_record` for a caller that does not use the record: the same
    /// commit without copying the record back (see `Store::record_event`),
    /// which for a large one costs about as much as the write.
    pub(crate) async fn record_update(
        &self,
        id: &str,
        kind: &str,
        data: Value,
        mutate: impl FnOnce(&mut AgentDetail) + Send + 'static,
    ) -> Result<()> {
        let (id, kind) = (id.to_owned(), kind.to_owned());
        self.stored(move |store| store.record_event(&id, &kind, &data, mutate).map(drop)).await
    }

    /// `record_update` of a Claude send's `turnRequested` or `message/bound`
    /// (`Store::record_send`): on a held record, written without copying the
    /// other Turns. `mutate` may run twice (see there).
    pub(crate) async fn record_send(
        &self,
        id: &str,
        kind: &str,
        data: Value,
        mutate: impl Fn(&mut AgentDetail) + Send + 'static,
    ) -> Result<()> {
        let (id, kind) = (id.to_owned(), kind.to_owned());
        self.stored(move |store| store.record_send(&id, &kind, &data, mutate).map(drop)).await
    }

    /// `record_update` of a Claude follow-up's `followUpQueued`
    /// (`Store::record_send_unless`): `mutate` is made unless `shown` finds the
    /// follow-up in some Turn, and on a held record written without copying
    /// the other Turns. Either may run twice (see there).
    pub(crate) async fn record_send_unless(
        &self,
        id: &str,
        kind: &str,
        data: Value,
        shown: impl Fn(&[Value]) -> bool + Send + 'static,
        mutate: impl Fn(&mut AgentDetail) + Send + 'static,
    ) -> Result<()> {
        let (id, kind) = (id.to_owned(), kind.to_owned());
        self.stored(move |store| store.record_send_unless(&id, &kind, &data, shown, mutate).map(drop)).await
    }

    /// `record_update` for a change to the metadata only (`Store::update_meta`):
    /// the send path's own changes, written without comparing a large record.
    pub(crate) async fn record_meta(
        &self,
        id: &str,
        kind: &str,
        data: Value,
        mutate: impl FnOnce(&mut crate::store::Meta<'_>) + Send + 'static,
    ) -> Result<()> {
        let (id, kind) = (id.to_owned(), kind.to_owned());
        self.stored(move |store| store.update_meta(&id, &kind, &data, mutate).map(drop)).await
    }

    /// This Agent's ownership lock (see the lock order on `Workspace`).
    pub(crate) async fn owner(&self, id: &str) -> OwnedMutexGuard<()> {
        let lock = self.owners.lock().unwrap().entry(id.into()).or_default().clone();
        lock.lock_owned().await
    }

    /// The Agent's live Codex connection and its generation (a lookup only;
    /// see the lock order above).
    pub(crate) fn codex_connection(&self, id: &str) -> Option<(u64, Arc<Rpc>)> {
        self.rpcs.lock().unwrap().get(id).filter(|c| !c.closing).map(|c| (c.generation, c.rpc.clone()))
    }

    /// The Codex executable this Core starts on its own host.
    pub(crate) fn codex_program(&self) -> &str {
        &self.program
    }

    pub fn projects_changed(&self) {
        let _ = self.changes.send(json!({"projects":true}));
    }

    /// Validate a project default on its own machine. This records what existed
    /// when saved; it neither reserves the folder nor limits Agent folders.
    pub async fn project_folder(&self, machine: &str, folder: &str) -> Result<String> {
        let folder = folder.trim();
        if folder.is_empty() || folder.len() > 4096 || folder.chars().any(char::is_control) {
            bail!("项目默认目录为空、过长或包含控制字符");
        }
        if machine == "local" {
            let path = std::fs::canonicalize(folder).context("项目默认目录不存在或无法读取")?;
            if !path.is_dir() { bail!("项目默认目录必须是文件夹"); }
            Ok(path.to_string_lossy().into_owned())
        } else {
            let machine = machine.to_owned();
            remote::canonicalize(&self.stored(move |store| store.machine(&machine)).await?, folder).await
        }
    }

    pub fn changed(&self, id: &str) {
        // perf-sse: `agent.changed`; clients refetch what they show of it.
        self.announce_changed(id);
        self.collaboration_wakeup.notify_one();
    }
    pub(crate) async fn gate(&self, id: &str) -> Arc<Mutex<()>> {
        self.gates
            .lock()
            .await
            .entry(id.into())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    pub async fn create(
        self: &Arc<Self>,
        name: String,
        goal: String,
        cwd: String,
        model: String,
    ) -> Result<Agent> {
        self.create_on(name, goal, cwd, model, None, None).await
    }

    pub async fn create_on(
        self: &Arc<Self>, name: String, _legacy_goal: String, cwd: String, model: String,
        machine_id: Option<String>, project_id: Option<String>,
    ) -> Result<Agent> {
        let permit = self.admission.enter_work()?;
        if name.trim().is_empty() || name.len() > 100 {
            bail!("请填写名称（最多 100 字节）");
        }
        if let Some(project) = project_id.clone() {
            self.stored(move |store| store.ensure_project_assignable(&project)).await?;
        }
        let machine = match machine_id.filter(|id| id != "local") {
            Some(id) => Some(self.stored(move |store| store.machine(&id)).await?),
            None => None,
        };
        let cwd = if let Some(machine) = &machine {
            remote::canonicalize(machine, &cwd).await?
        } else {
            let path = std::fs::canonicalize(cwd).context("工作目录不存在或无法读取")?;
            if !path.is_dir() { bail!("工作目录必须是文件夹"); }
            path.to_string_lossy().into_owned()
        };
        let id = uuid::Uuid::new_v4().to_string();
        let colors = ["yuzu", "sage", "rose", "sky"];
        let count = self.stored(|store| store.agents()).await?.len();
        let a = Agent {
            id: id.clone(),
            name: name.trim().into(),
            goal: String::new(),
            work_summary: None,
            project_id,
            cwd,
            model,
            settings: AgentSettings::default(),
            color: colors[count % colors.len()].into(),
            harness: "codex".into(),
            claude_session_id: None,
            opencode_session_id: None,
            thread_id: None,
            status: "offline".into(),
            closed_at: None,
            created_at: now(),
            updated_at: now(),
            unread_count: 0,
            pending_count: 0,
            last_message: None,
            last_seq: 0,
            reviewed_seq: 0,
            rev: 0,
            error: None,
            remote: machine.map(RemoteAgent::new),
            connection_state: "disconnected".into(),
        };
        let detail = AgentDetail {
            agent: a.clone(),
            turns: vec![],
            history: None,
            pending: vec![],
            artifacts: vec![],
            context_usage: None,
            message_receipts: vec![],
            claude_runtime: None,
            codex_handoff: None,
        };
        self.stored(move |store| store.insert_created(&detail)).await?;
        self.changed(&id);
        let this = self.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let gate = this.gate(&id).await;
            let _held = gate.lock().await;
            if let Err(e) = this.ensure(&id).await {
                this.failed(&id, &e).await;
            }
        });
        Ok(a)
    }

    /// Blocking: for event handlers already on a blocking thread. Async code
    /// uses `failed`.
    pub(crate) fn fail(&self, id: &str, error: &anyhow::Error) {
        if record_failure(&self.store, id, error) { self.changed(id); }
    }

    pub(crate) async fn failed(&self, id: &str, error: &anyhow::Error) {
        let (agent, error) = (id.to_owned(), failure(error));
        if self.stored(move |store| Ok(record_failure(store, &agent, &error))).await.unwrap_or(false) {
            self.changed(id);
        }
    }

    async fn connect(self: &Arc<Self>, id: &str) -> Result<Connection> {
        let (tx, mut rx) = mpsc::channel(256);
        let events = crate::updates::events::EventBarrier::new(tx.clone());
        let backlog = Arc::new(crate::backlog::Backlog::default());
        let rpc = if id == "_catalog" {
            Rpc::spawn(&self.program, &[], tx).await?
        } else {
            let tx = crate::backlog::EventSender::observed(tx, backlog.clone());
            // Connecting reads and writes the Agent's fields only, so neither
            // reads nor copies its history (T-140).
            let agent = self.listed(id).await?;
            self.record_meta(id, "runtime/connecting", json!({}), |m| {
                m.agent.connection_state = "connecting".into();
            }).await?;
            self.changed(id);
            let result = async {
                if let Some(remote_agent) = agent.remote {
                    self.ensure_collaboration_tunnel(&remote_agent.machine).await?;
                    let runtime = remote::ensure_runtime(&remote_agent.machine,
                        &self.stored(|store| store.workspace_id()).await?, id).await?;
                    if let Some(previous) = &remote_agent.runtime {
                        if previous.instance_id != runtime.instance_id {
                            self.record_meta(id, "runtime/replaced", json!({
                                "previousInstanceId":previous.instance_id,"instanceId":runtime.instance_id,
                                "note":"Native runtime changed; only session history can be resumed."}), |_| {}).await?;
                        }
                    }
                    let located = runtime.clone();
                    self.record_meta(id, "runtime/located", json!({"instanceId":runtime.instance_id}), move |m| {
                        if let Some(r) = &mut m.agent.remote { r.runtime = Some(located); }
                    }).await?;
                    remote::connect(&remote_agent.machine, &runtime, tx).await
                } else {
                    Rpc::spawn(&self.program, &[], tx).await
                }
            }.await;
            if result.is_err() {
                self.record_meta(id, "runtime/connectFailed", json!({}), |m| {
                    m.agent.connection_state = "disconnected".into();
                }).await?;
                self.changed(id);
            }
            result?
        };
        let connection = Connection {
            generation: self.next_generation.fetch_add(1, Ordering::Relaxed),
            rpc,
            closing: false,
            events: Some(events.clone()),
            attachment: Default::default(),
        };
        {
            let _owned = self.owner(id).await;
            self.rpcs.lock().unwrap().insert(id.into(), connection.clone());
            self.codex_mcp.forget(id);
            self.codex_plan.forget(id);
            self.codex_usage_reconnected(id, connection.generation).await;
            if id != "_catalog" {
                self.backlogs.track(id, connection.generation, backlog.clone());
            }
        }
        // Ownership exists before initialize can emit a server request.
        let this = self.clone();
        let agent_id = id.to_owned();
        let generation = connection.generation;
        let event_barrier = Arc::downgrade(&events);
        tokio::spawn(async move {
            while let Some(message) = rx.recv().await {
                let native = crate::backlog::is_native(&message);
                if event_barrier.upgrade().is_some_and(|barrier| barrier.acknowledge(&message)) { continue; }
                let _event = this.admission.enter_event();
                this.dispatch_event(&agent_id, generation, message).await;
                if native { backlog.applied(); }
            }
        });
        if let Err(e) = connection.rpc.initialize().await {
            // No thread operation has been sent yet, so this transport can close.
            self.remove_connection(id, generation).await;
            return Err(e);
        }
        Ok(connection)
    }

    pub(crate) async fn remove_connection(&self, id: &str, generation: u64) {
        let owned = self.owner(id).await;
        self.remove_connection_owned(id, generation, owned).await;
    }

    async fn remove_connection_owned(&self, id: &str, generation: u64, owned: OwnedMutexGuard<()>) {
        let removed = {
            let mut rpcs = self.rpcs.lock().unwrap();
            if same_generation(rpcs.get(id), generation) { rpcs.remove(id) } else { None }
        };
        let Some(connection) = removed else { return };
        self.codex_context.detached(id, generation);
        self.codex_usage_event(id, generation, &json!({"method":"yuzuno/disconnected"}));
        connection.rpc.close();
        if id != "_catalog" {
            let detached = id.to_owned();
            let _ = self.stored_owned(owned, move |store| store.update_meta(&detached, "runtime/detached", &json!({}), |m| {
                m.agent.connection_state = "disconnected".into();
            })).await;
            self.changed(id); // perf-sse: clients no longer poll for it
        }
    }

    pub(crate) async fn ensure(self: &Arc<Self>, id: &str) -> Result<Connection> {
        self.ensure_with_context(id, false).await
    }

    async fn ensure_with_context(self: &Arc<Self>, id: &str, same_thread_only: bool) -> Result<Connection> {
        let a = self.send_view(id).await?.agent;
        ensure_agent_open(&a)?;
        let agent = id.to_owned();
        anyhow::ensure!(!self.stored(move |store| store.codex_handoff_pending(&agent)).await?, "导入会话尚未接续；请结束原客户端当前 Turn，然后点击重新连接或发送消息");
        anyhow::ensure!(a.harness == "codex", "此操作需要 Codex 原生会话；不会为其他 Harness 创建 Codex 会话");
        let existing = self.rpcs.lock().unwrap().get(id).cloned();
        if let Some(connection) = existing {
            let attaching = connection.attachment.lock().await.is_some();
            if attaching { return self.finish_attach(id, connection).await; }
            if self.codex_context.needs_resume(id, connection.generation) {
                return self.resume_context(id, connection, false).await;
            }
            return Ok(connection);
        }
        // Attaching keeps the Agent as it is now. The send view has it, with
        // its project, without copying the record's Items and payloads.
        let a = self.send_view(id).await?.agent;
        if a.status == "uncertain" && a.thread_id.is_none() {
            bail!("会话创建结果尚未确认且没有会话 ID；不会自动创建另一会话，请先检查原生会话记录");
        }
        let connection = self.connect(id).await?;
        if let Err(error) = crate::codex_context::check(&connection.rpc, &a.cwd, &a.settings).await {
            self.remove_connection(id, connection.generation).await;
            return Err(error);
        }
        // Compose both native overrides once so every start/resume path keeps
        // permission routing, reasoning settings and the Agent-scoped MCP.
        let initial_params = match permission_params(&connection, &a, start_params(&a), false).await {
            Ok(params) => self.collaboration_codex_params(&a, params).await,
            Err(error) => Err(error),
        };
        // Start and resume alike: a compaction rebuilds the Thread's opening
        // context from its current developer instructions, so a resume that
        // left them out would lose the notice and the Brief rules there.
        let initial_params = match initial_params {
            Ok(params) => {
                let params = crate::results::with_capability_notice(&connection.rpc, &a.cwd, params).await;
                Ok(crate::brief_turns::with_hard_rules(self, &a.id, params).await)
            }
            Err(error) => Err(error),
        };
        let initial_params = match initial_params {
            Ok(params) => params,
            Err(error) => {
                self.remove_connection(id, connection.generation).await;
                return Err(error);
            }
        };
        // Where the record stood when the request went out: its rev and seq,
        // and for an imported thread the status of each Turn (`recovery_page`).
        let before_attach = self.send_view(id).await?;
        let agent = id.to_owned();
        let imported = self.stored(move |store| store.is_codex_import(&agent)).await?;
        let reply = if let Some(thread) = &a.thread_id {
            // Native resume replays usage from the prior configuration, even
            // on a fresh app-server. Keep persisted usage last-known until a
            // new turn reports the running thread's window.
            self.codex_context.awaiting_fresh_usage(id, connection.generation);
            let mut params = resume_params(thread, &a);
            if imported { params["excludeTurns"] = true.into(); }
            for (key, value) in initial_params.as_object().unwrap() {
                params[key] = value.clone();
            }
            connection.rpc.begin_request("thread/resume", params).await
        } else {
            // A remote runtime survives this Core. Reserve creation before the
            // wire write so a crash cannot create a second native Thread.
            self.update_record(id, "thread/createRequested", json!({}), |d| {
                d.agent.status = "uncertain".into();
            }).await?;
            connection
                .rpc
                .begin_request("thread/start", initial_params.clone())
                .await
        };
        let reply = match reply {
            Ok(reply) => reply,
            Err(error) => {
                self.remove_connection(id, connection.generation).await;
                return Err(error);
            }
        };
        *connection.attachment.lock().await = Some(Attachment {
            request_seq: before_attach.agent.last_seq,
            request_rev: before_attach.agent.rev,
            new_empty_thread: a.thread_id.is_none(),
            replacing_empty_thread: false, same_thread_only,
            agent: a, before: before_attach, imported, initial_params, reply,
        });
        self.finish_attach(id, connection).await
    }

    fn reconnect_timeout(&self) -> std::time::Duration {
        #[cfg(test)]
        { return std::time::Duration::from_millis(self.reconnect_timeout_ms.load(Ordering::Relaxed)); }
        #[cfg(not(test))]
        { std::time::Duration::from_secs(45) }
    }

    async fn attach_state(&self, id: &str, generation: u64, state: &'static str) -> Result<()> {
        let owned = self.owner(id).await;
        if !same_generation(self.rpcs.lock().unwrap().get(id), generation) { return Ok(()); }
        let agent = id.to_owned();
        self.stored_owned(owned, move |store| store.update_meta(&agent, "runtime/attachState",
            &json!({"connectionState":state}), |m| m.agent.connection_state = state.into())).await?;
        self.changed(id);
        Ok(())
    }

    async fn finish_attach(self: &Arc<Self>, id: &str, connection: Connection) -> Result<Connection> {
        let result = self.finish_attach_inner(id, connection.clone()).await;
        let mut retryable = false;
        if let Err(error) = &result {
            let mut slot = connection.attachment.lock().await;
            if slot.as_ref().is_some_and(|attempt| attempt.same_thread_only)
                && error.downcast_ref::<OutcomeUnknown>().is_none() {
                // A completed rejection cannot be waited on again forever.
                // Keep the transport and a retryable same-thread obligation;
                // a later reconnect uses the latest saved settings. Unknown
                // outcomes retain their original PendingReply without replay.
                self.codex_context.require_resume(id, connection.generation);
                *slot = None;
                retryable = true;
            }
            drop(slot);
            // This attempt has returned; it is no longer actively connecting.
            // Keep an unresolved native request/process available for checking.
            self.attach_state(id, connection.generation, "unconfirmed").await?;
        }
        result.map_err(|error| if retryable {
            error.context("原会话恢复被拒绝；可保存修正后的设置，再重新连接。原会话与 app-server 已保留")
        } else { error })
    }

    async fn finish_attach_inner(self: &Arc<Self>, id: &str, connection: Connection) -> Result<Connection> {
        let mut slot = connection.attachment.lock().await;
        let attempt = slot.as_mut().context("原生恢复请求已结束，请重新核对")?;
        self.attach_state(id, connection.generation, "connecting").await?;
        let mut result = attempt.reply.wait(self.reconnect_timeout()).await;
        let missing_rollout = !attempt.new_empty_thread && attempt.agent.thread_id.as_ref()
            .zip(result.as_ref().err().and_then(|error| error.downcast_ref::<RpcError>()))
            .is_some_and(|(thread, error)| error.confirms_missing_rollout(thread));
        if missing_rollout && !attempt.same_thread_only {
            let (agent, thread) = (id.to_owned(), attempt.agent.thread_id.clone().unwrap());
            if self.stored(move |store| store.begin_empty_thread_replacement(&agent, &thread)).await? {
                attempt.replacing_empty_thread = true;
                attempt.new_empty_thread = true;
                let reserved = self.send_view(id).await?.agent;
                attempt.request_seq = reserved.last_seq;
                attempt.request_rev = reserved.rev;
                attempt.reply = connection.rpc.begin_request("thread/start", attempt.initial_params.clone()).await?;
                result = attempt.reply.wait(self.reconnect_timeout()).await;
            }
        }
        let a = attempt.agent.clone();
        let (new_empty_thread, replacing_empty_thread, imported) =
            (attempt.new_empty_thread, attempt.replacing_empty_thread, attempt.imported);
        // Shared with the attachment, which keeps it unchanged for a later
        // finish (T-140).
        let result = match result {
            Ok(v) => v,
            Err(e) => {
                // Structured, so the GUI can explain it and offer an explicit
                // fork. Nothing here retries, takes over or forks by itself.
                let writer_conflict = matches!((&a.thread_id, e.downcast_ref::<RpcError>(), &a.remote),
                    (Some(thread), Some(rpc_error), None) if rpc_error.reports_active_writer(thread));
                if writer_conflict {
                    self.update_record(id, "codex/writerConflict", json!({"threadId":a.thread_id}), |d| {
                        d.codex_handoff.get_or_insert_with(Default::default).writer_conflict_at = Some(crate::model::now());
                    }).await?;
                }
                if new_empty_thread && e.downcast_ref::<RpcError>().is_some() {
                    let message = e.to_string();
                    self.update_record(
                        id,
                        "thread/createRejected",
                        json!({"message":message}),
                        move |d| {
                            d.agent.status = "error".into();
                            d.agent.error = Some(message);
                        },
                    ).await?;
                }
                // A timeout must not drop the only transport and kill accepted work.
                if e.downcast_ref::<OutcomeUnknown>().is_none() && !attempt.same_thread_only {
                    self.remove_connection(id, connection.generation).await;
                }
                return Err(e);
            }
        };
        let thread_id = result["thread"]["id"]
            .as_str()
            .context("Codex 未返回会话 ID")?
            .to_owned();
        if !new_empty_thread {
            anyhow::ensure!(a.thread_id.as_deref() == Some(thread_id.as_str()), "Codex 恢复了不同会话；原会话未确认");
        }
        // An imported record's Turns are the recovery page's, kept apart
        // from the reply, which stays as it came.
        let (imported_history, page_turns) = if imported {
            anyhow::ensure!(a.thread_id.as_deref() == Some(thread_id.as_str()), "Codex 恢复了不同会话；不会替换导入记录");
            let page = match crate::codex_sessions::recovery_page(&connection.rpc, &thread_id, &attempt.before).await {
                Ok(page) => page,
                Err(error) => {
                    if !attempt.same_thread_only {
                        self.remove_connection(id, connection.generation).await;
                    }
                    return Err(error);
                }
            };
            let history = crate::model::HistoryWindow { loaded_count: page.turns.len(), has_more: page.has_more, next_cursor: page.next_cursor };
            (Some(history), Some(page.turns))
        } else { (None, None) };
        let owned = self.owner(id).await;
        if !same_generation(self.rpcs.lock().unwrap().get(id), connection.generation) {
            return Err(OutcomeUnknown("连接在恢复期间结束；会话状态需要重新确认".into()).into());
        }
        if a.remote.is_some() && !attempt.same_thread_only {
            let turns = page_turns.as_deref().or(result["thread"]["turns"].as_array().map(Vec::as_slice));
            self.codex_context.resumed_running_turn(id, connection.generation, turns.unwrap_or_default());
        }
        // The mode Codex resumed the thread in, if it says (/plan); a new
        // thread's answer says none. Announced with the attachment below.
        self.codex_plan.report(id, connection.generation, &result["collaborationMode"], "resume");
        self.codex_context.attached(id, connection.generation, &a.settings,
            attempt.same_thread_only || a.remote.is_none() || new_empty_thread);

        let agent = id.to_owned();
        let (request_seq, request_rev) = (attempt.request_seq, attempt.request_rev);
        let preserve_settings = attempt.same_thread_only;
        self.stored_owned(owned, move |store| {
            let id = agent.as_str();
            let changes = store.changed_items_since(id, request_rev)?;
            let has_new_error = store.has_error_since(id, request_seq)?;
            let thread = &result["thread"];
            store.record_event(
                id,
                "thread/attached",
                &json!({"threadId":thread_id,
                    "newEmptyThread":new_empty_thread,"turnRequestJournalVersion":1}),
                |d| {
                    d.agent.thread_id = Some(thread_id);
                    d.agent.connection_state = "connected".into();
                    // Yuzuno now owns the writer; an earlier conflict is resolved.
                    if let Some(handoff) = &mut d.codex_handoff { handoff.writer_conflict_at = None; }
                    if let Some(history) = imported_history { d.history = Some(history); }
                    match page_turns {
                        Some(turns) => apply_snapshot_turns(d, thread, Some(turns), &changes),
                        // The kept reply's Turns, copied one at a time as
                        // they merge, not a whole history first (T-140).
                        None => apply_snapshot_turns(d, thread, thread["turns"].as_array().map(|turns| turns.iter().cloned()), &changes),
                    }
                    d.confirm_message_receipts();
                    if !has_new_error { clear_transport_error(d, thread); }
                    if replacing_empty_thread {
                        d.agent.error = None;
                    }
                    if !preserve_settings {
                        if let Some(model) = result["model"].as_str() { d.agent.model = model.into(); }
                    }
                    if d.agent.settings.reasoning_effort.is_none() {
                        d.agent.settings.reasoning_effort = result["reasoningEffort"].as_str().map(str::to_owned);
                    }
                },
            )
        }).await?;
        *slot = None;
        drop(slot);
        self.settle_child_requests(id, &connection.rpc, connection.generation).await;
        let agent = id.to_owned();
        let attached = self.stored(move |store| store.agent(&agent)).await?;
        // A new native process accepted current overrides above. Only a
        // surviving remote process can retain an older loaded thread config.
        let surviving_remote = !new_empty_thread && a.remote.as_ref().and_then(|r| r.runtime.as_ref())
            .zip(attached.remote.as_ref().and_then(|r| r.runtime.as_ref()))
            .is_some_and(|(before, after)| before.instance_id == after.instance_id);
        if surviving_remote {
            if let Some(thread) = attached.thread_id {
                self.verify_remote_collaboration(id, &thread, connection.generation, &connection.rpc).await;
            }
        } else {
            self.collaboration_started(id, connection.generation).await;
        }
        self.record_recovered_completions(id).await?;
        self.changed(id);
        Ok(connection)
    }

    pub(crate) fn collaboration_generation(&self, id: &str) -> Option<u64> {
        let codex = self.rpcs.lock().unwrap().get(id).map(|c| c.generation);
        codex.or_else(|| self.claudes.lock().unwrap().get(id).map(|c| c.generation))
            .or_else(|| self.opencodes.lock().unwrap().get(id).map(|c| c.generation))
    }

    async fn reconcile(self: &Arc<Self>, id: &str) -> Result<()> {
        let connection = self.ensure(id).await?;
        let result = self.reconcile_connection(id, &connection).await;
        if result.is_err() {
            self.attach_state(id, connection.generation, "unconfirmed").await?;
        }
        result
    }

    pub(crate) async fn reconcile_connection(self: &Arc<Self>, id: &str, connection: &Connection) -> Result<()> {
        self.recover_rewind(id, connection).await?;
        let d = self.send_view(id).await?;
        let thread = d
            .agent
            .thread_id.clone()
            .context("原任务状态仍未知；没有可恢复的会话 ID，不会重复发送")?;
        let agent = id.to_owned();
        let imported = self.stored(move |store| store.is_codex_import(&agent)).await?;
        let mut result = connection
            .rpc
            .request_within(
                "thread/read",
                json!({"threadId":thread,"includeTurns":!imported}),
                self.reconnect_timeout(),
            )
            .await?;
        anyhow::ensure!(result["thread"]["id"].as_str() == Some(thread.as_str()), "Codex 核对返回了不同会话；原会话未确认");
        let imported_history = if imported {
            let page = crate::codex_sessions::recovery_page(&connection.rpc, &thread, &d).await?;
            let history = crate::model::HistoryWindow { loaded_count: page.turns.len(), has_more: page.has_more, next_cursor: page.next_cursor };
            result["thread"]["turns"] = page.turns.into();
            Some(history)
        } else { None };
        let owned = self.owner(id).await;
        if !same_generation(self.rpcs.lock().unwrap().get(id), connection.generation) {
            return Err(OutcomeUnknown("连接在核对期间结束；原任务状态仍未知".into()).into());
        }
        // `d` was read before thread/read was sent.
        let (agent, requested_rev, requested_at) = (id.to_owned(), d.agent.rev, d.agent.last_seq);
        self.stored_owned(owned, move |store| {
            let id = agent.as_str();
            let changes = store.changed_items_since(id, requested_rev)?;
            let has_new_error = store.has_error_since(id, requested_at)?;
            let turns = take_turns(&mut result["thread"]);
            store.record_event(
                id,
                "thread/reconciled",
                &json!({"threadId":thread}),
                |current| {
                    current.agent.connection_state = "connected".into();
                    if let Some(history) = imported_history { current.history = Some(history); }
                    apply_snapshot_turns(current, &result["thread"], turns, &changes);
                    current.confirm_message_receipts();
                    if !has_new_error { clear_transport_error(current, &result["thread"]); }
                },
            )
        }).await?;
        self.settle_child_requests(id, &connection.rpc, connection.generation).await;
        self.record_recovered_completions(id).await?;
        self.changed(id);
        Ok(())
    }

    async fn record_recovered_completions(&self, id: &str) -> Result<()> {
        let id = id.to_owned();
        self.stored(move |store| {
            // Live Turns journal their completion; the whole record is read
            // only when a finished Turn has none (T-140).
            if !store.has_unrecorded_completion(&id, &store.send_view(&id)?.turns)? {
                return Ok(());
            }
            let after = store.detail(&id)?;
            store.record_recovered_completions(&id, &after.turns)
        }).await
    }

    /// Attach and reconcile only. This operation never sends a new model Turn.
    pub async fn reconnect(self: &Arc<Self>, id: &str) -> Result<AgentDetail> {
        let _permit = self.admission.enter_work()?;
        self.reconnect_accepted(id, &_permit).await
    }

    pub(crate) async fn reconnect_accepted(self: &Arc<Self>, id: &str, permit: &crate::updates::admission::Permit) -> Result<AgentDetail> {
        permit.validate(&self.admission)?;
        match self.listed(id).await?.harness.as_str() {
            "claude" => return self.claude_reconnect_accepted(id, permit).await,
            "opencode" => return self.opencode_reconnect_accepted(id, permit).await,
            _ => {}
        }
        self.reconnect_codex(id, true).await?.context("record")
    }

    /// `reconnect`, answered with the Agent as listed: for a caller that reads
    /// the conversation afterwards its own way (the UI's windowed detail). The
    /// same admission, gate and reconcile, without reading the record whole to
    /// return it. Inside, its checks and its connection-state and failure
    /// writes take the Agent's fields only. The whole record is still loaded
    /// by a write that changes Turns (a reconcile's merge, a Claude or
    /// OpenCode runtime becoming ready), by a recovered completion and by a
    /// Claude session's history check (T-140).
    pub async fn reconnect_summary(self: &Arc<Self>, id: &str) -> Result<crate::model::Agent> {
        let permit = self.admission.enter_work()?;
        self.reconnect_settled(id, &permit).await?;
        self.listed(id).await
    }

    /// `reconnect_accepted` for a caller that does not use the record, which
    /// for a long history saves reading it whole (T-140).
    pub(crate) async fn reconnect_settled(self: &Arc<Self>, id: &str, permit: &crate::updates::admission::Permit) -> Result<()> {
        permit.validate(&self.admission)?;
        match self.listed(id).await?.harness.as_str() {
            "claude" => return self.claude_reconnect_gated(id, permit, false).await.map(drop),
            "opencode" => return self.opencode_reconnect_gated(id, permit, false).await.map(drop),
            _ => {}
        }
        self.reconnect_codex(id, false).await.map(drop)
    }

    /// Reconnects a Codex Agent under its gate; with `read`, returns the
    /// record as the reconnect left it, read under the same gate.
    async fn reconnect_codex(self: &Arc<Self>, id: &str, read: bool) -> Result<Option<AgentDetail>> {
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let agent = id.to_owned();
        self.stored(move |store| store.activate_codex_import(&agent)).await?;
        // Explicit reconnect only: a remote detach releases the subscription,
        // not the surviving process. Also recover an attach that ended before
        // recording readiness. A fresh attach/probe decides whether it worked.
        let readiness = self.collaboration_status(id).await;
        if self.collaboration_url.get().is_some()
            && !readiness.as_ref().is_some_and(|s| s.ready)
            // An unconfirmed attach still owns its native request and process.
            // Missing MCP readiness is not permission to kill accepted work.
            && self.send_view(id).await?.agent.connection_state == "connected"
            && (self.send_view(id).await?.agent.remote.is_some() || readiness.is_none()) {
            let owned = self.owner(id).await;
            let connection = self.rpcs.lock().unwrap().get(id).cloned();
            if let Some(connection) = connection {
                // The remote helper retains the process, not pending RPCs.
                // Keep this transport while an approval (even a sent response
                // awaiting resolution) still belongs to it. Check under owner
                // so dispatch cannot insert an approval between check/detach.
                let pending = self.send_view(id).await?.pending.iter().any(|p|
                    !p.stale && p.params["_runtimeGeneration"].as_u64() == Some(connection.generation));
                if !pending && !self.codex_context.needs_resume(id, connection.generation) {
                    self.remove_connection_owned(id, connection.generation, owned).await;
                }
            }
        }
        if let Err(error) = self.reconcile(id).await {
            self.failed(id, &error).await;
            return Err(error);
        }
        if read { Ok(Some(self.detail(id).await?)) } else { Ok(None) }
    }

    /// Close is a reversible Workspace lifecycle action, independent of native
    /// session history. Serialize it with sends, settings and reconnection.
    pub async fn close_agent(self: &Arc<Self>, id: &str) -> Result<AgentDetail> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        self.close_agent_locked(id).await
    }

    async fn close_agent_locked(self: &Arc<Self>, id: &str) -> Result<AgentDetail> {
        // Its state and each Turn's status, as the send view has them; the
        // whole record only where it is the answer (T-140).
        let mut view = self.send_view(id).await?;
        if view.agent.closed_at.is_some() { return self.detail(id).await; }
        if view.agent.harness == "claude" {
            self.claude_close_runtime(id).await?;
        } else if view.agent.harness == "opencode" {
            self.opencode_close_runtime(id).await?;
        } else {
            // A detached remote turn may still be running. Reconcile native
            // history first, without sending/replaying any task.
            if view.agent.remote.is_some() && view.agent.thread_id.is_some()
                && !self.rpcs.lock().unwrap().contains_key(id) {
                self.reconcile(id).await.context("远程状态尚未确认，Agent 未关闭")?;
                view = self.send_view(id).await?;
            }
            let connection = self.rpcs.lock().unwrap().get(id).cloned();
            if let Some(connection) = &connection {
                if let Some(turn_id) = view.turns.iter().rev()
                    .find(|t| t["status"] == "inProgress")
                    .and_then(|t| t["id"].as_str()).map(str::to_owned) {
                    let interrupted = connection.rpc.request("turn/interrupt", json!({
                        "threadId":view.agent.thread_id,"turnId":turn_id
                    })).await;
                    // A completion can win the race with the interrupt request.
                    let finished = |d: &AgentDetail| d.turns.iter().any(|t| t["id"] == turn_id
                        && matches!(t["status"].as_str(), Some("completed" | "interrupted" | "failed")));
                    if !finished(&self.send_view(id).await?) {
                        interrupted.context("无法确认中断，Agent 未关闭")?;
                        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
                        loop {
                            if finished(&self.send_view(id).await?) { break; }
                            anyhow::ensure!(tokio::time::Instant::now() < deadline,
                                "中断尚未得到原生执行结果确认；Agent 未关闭，请稍后重试");
                            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
                        }
                    }
                }
            }
            let agent = self.listed(id).await?;
            {
                let _owned = self.owner(id).await;
                if let Some(current) = self.rpcs.lock().unwrap().get_mut(id) { current.closing = true; }
            }
            let shutdown = async {
                if let Some(remote_agent) = &agent.remote {
                    remote::stop_runtime(&remote_agent.machine, &self.stored(|store| store.workspace_id()).await?, id,
                        remote_agent.runtime.as_ref()).await?;
                }
                if let Some(connection) = &connection {
                    connection.rpc.close_and_wait().await?;
                    // Remove only this generation; an event already received may
                    // have detached it. Late events then cannot revive this Agent.
                    self.remove_connection(id, connection.generation).await;
                }
                Result::<()>::Ok(())
            }.await;
            if shutdown.is_err() {
                let _owned = self.owner(id).await;
                if let Some(current) = self.rpcs.lock().unwrap().get_mut(id) { current.closing = false; }
            }
            shutdown?;
        }
        let closed = self.update_record(id, "agent/closed", json!({}), |d| {
            d.agent.closed_at = Some(now());
            d.agent.status = "offline".into();
            d.agent.connection_state = "disconnected".into();
            d.pending.clear();
            if let Some(usage) = &mut d.context_usage { usage.stale = true; }
            for receipt in &mut d.message_receipts {
                if receipt.status == "sending" { receipt.status = "uncertain".into(); }
            }
            // A previously disconnected local process can have an unknown
            // final result. Closing never invents successful tool completion.
            for turn in &mut d.turns {
                if turn["status"] == "inProgress" { turn["status"] = "unknown".into(); }
            }
        }).await?;
        self.changed(id);
        Ok(closed)
    }

    pub async fn reopen_agent(self: &Arc<Self>, id: &str) -> Result<AgentDetail> {
        let _permit = self.admission.enter_work()?;
        {
            let gate = self.gate(id).await;
            let _held = gate.lock().await;
            if !self.mark_reopened(id).await? { return self.detail(id).await; }
        }
        // Native resume preserves the existing identity and session. A failed
        // reconnection leaves an open, retryable Agent with the original history.
        self.reconnect_accepted(id, &_permit).await
    }

    /// `reopen_agent`, answered with the Agent as listed, which is all the
    /// HTTP route returns: the same steps, without reading the history whole.
    pub async fn reopen_agent_summary(self: &Arc<Self>, id: &str) -> Result<crate::model::Agent> {
        let permit = self.admission.enter_work()?;
        {
            let gate = self.gate(id).await;
            let _held = gate.lock().await;
            if !self.mark_reopened(id).await? { return self.listed(id).await; }
        }
        self.reconnect_settled(id, &permit).await?;
        self.listed(id).await
    }

    /// Called under the Agent gate: marks a closed Agent open again (its Agent
    /// fields only); false if it was open. Neither reads its history (T-140).
    async fn mark_reopened(&self, id: &str) -> Result<bool> {
        if self.listed(id).await?.closed_at.is_none() { return Ok(false); }
        self.record_meta(id, "agent/reopened", json!({}), |m| {
            m.agent.closed_at = None;
            m.agent.status = "offline".into();
            m.agent.connection_state = "disconnected".into();
        }).await?;
        self.changed(id);
        Ok(true)
    }

    pub async fn delete_agent(self: &Arc<Self>, id: &str) -> Result<()> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        self.close_agent_locked(id).await?;
        let closed = self.detail(id).await?;
        if closed.agent.remote.is_some() {
            let workspace = self.stored(|store| store.workspace_id()).await?;
            // Older image-transfer builds had no dedicated cleanup marker.
            // Even a rejected/uncertain attempt may have installed a partial
            // batch before failing; pure drafts have no message/requested.
            let image_attempted = closed.message_receipts.iter().any(|r| !r.input.images.is_empty());
            crate::remote_images::cleanup(&self.data_dir, &workspace, &closed.agent, image_attempted).await?;
        }
        let agent = id.to_owned();
        self.stored(move |store| store.delete_closed_agent(&agent)).await?;
        self.changed(id);
        // A source must not keep pointing at a deleted continuation; it shows
        // its writer conflict again and can be forked by an explicit request.
        let agent = id.to_owned();
        for source in self.stored(move |store| store.forked_to(&agent)).await? {
            let deleted = id.to_owned();
            self.update_record(&source, "codex/forkReleased", json!({"agentId":id}), move |d| {
                if let Some(handoff) = &mut d.codex_handoff {
                    if handoff.forked_to.as_ref().is_some_and(|link| link.agent_id == deleted) { handoff.forked_to = None; }
                }
            }).await?;
            self.changed(&source);
        }
        Ok(())
    }

    /// Remote runtimes survive Core/SSH lifetimes. Retry attachment with bounded
    /// backoff; UI activity is not their lifecycle owner.
    pub fn start_remote_recovery(self: &Arc<Self>) {
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            let mut retry: HashMap<String, (std::time::Instant, u32)> = HashMap::new();
            loop {
                tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                let Some(ws) = weak.upgrade() else { break; };
                let agents = ws.stored(|store| store.agents()).await.unwrap_or_default();
                for agent in agents {
                    let Ok(_permit) = ws.admission.enter_work() else { break; };
                    if agent.closed_at.is_some() || agent.remote.is_none() || agent.thread_id.is_none() { continue; }
                    if agent.connection_state == "connecting" { continue; }
                    let now = std::time::Instant::now();
                    if retry.get(&agent.id).is_some_and(|(next, _)| *next > now) { continue; }
                    if agent.connection_state == "connected" {
                        // MCP's reverse forward can fail independently of the
                        // native session transport. Repair only that tunnel.
                        if let Some(remote) = &agent.remote {
                            if self::remote::validate_machine(&remote.machine).is_ok()
                                && ws.ensure_collaboration_tunnel(&remote.machine).await.is_err() {
                                retry.insert(agent.id.clone(), (now + std::time::Duration::from_secs(15), 0));
                                continue;
                            }
                        }
                        retry.remove(&agent.id);
                        continue;
                    }
                    let attempts = retry.get(&agent.id).map_or(0, |(_, n)| *n);
                    let delay = (2u64.saturating_pow(attempts.min(5))).min(30);
                    retry.insert(agent.id.clone(), (now + std::time::Duration::from_secs(delay), attempts + 1));
                    // Each attempt is serialized by the same gate as send and manual reconnect.
                    let _ = ws.reconnect_settled(&agent.id, &_permit).await;
                }
            }
        });
    }

    pub async fn send(self: &Arc<Self>, id: &str, text: String) -> Result<Value> {
        // The harness is the Agent's: its listed view, not its history (T-140).
        match self.listed(id).await?.harness.as_str() {
            "claude" => return self.claude_send(id, text).await,
            "opencode" => return self.opencode_send(id, text).await,
            _ => {}
        }
        let _permit = self.admission.enter_work()?;
        if text.trim().is_empty() || text.len() > 100_000 {
            bail!("消息不能为空，且不能超过 100 KB");
        }
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let agent = id.to_owned();
        self.stored(move |store| store.activate_codex_import(&agent)).await?;
        self.send_locked(id, text, None).await
    }

    pub(crate) async fn send_locked(self: &Arc<Self>, id: &str, text: String, client_id: Option<&str>) -> Result<Value> {
        self.send_images_locked(id, text, client_id, &[], &[]).await
    }

    async fn send_images_locked(self: &Arc<Self>, id: &str, text: String, client_id: Option<&str>, images: &[String], skills: &[SkillRef]) -> Result<Value> {
        self.ensure_rewind_settled(id).await?;
        let detail = self.send_view(id).await?;
        ensure_agent_open(&detail.agent)?;
        if detail.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain")
            && Some(r.input.client_message_id.as_str()) != client_id) {
            bail!("上一条消息的结果尚未确认，请先重连核对；未发送新任务");
        }
        self.confirm_previous_turn(id, &detail).await?;
        if turn_busy(&detail) {
            bail!("当前 Turn 尚未结束；请携带原 Turn ID 发送补充消息");
        }
        let connection = self.ensure(id).await?;
        self.require_collaboration(id).await?;
        let detail = self.send_view(id).await?;
        if turn_busy(&detail) {
            bail!("原会话仍在执行或等待回应，未发送新任务");
        }
        let thread = detail.agent.thread_id.clone()
            .context("会话 ID 尚未确认，未发送新任务")?;
        let mut params = turn_params(&detail.agent, &thread, &text, client_id);
        if !images.is_empty() { params["input"] = self.image_input(id, &detail.agent, &connection, &text, images).await?; }
        if let Some(input) = params["input"].as_array_mut() { input.extend(crate::codex_skills::input_items(skills)); }
        let params = permission_params(&connection, &detail.agent, params, true).await?;
        self.require_collaboration(id).await?;
        anyhow::ensure!(same_generation(self.rpcs.lock().unwrap().get(id), connection.generation),
            "连接已变化，新消息未发送");
        // Persist intent before crossing the process boundary. A crash between
        // the wire write and its response must not make a used thread look empty.
        self
            .record_meta(id, "turn/requested", json!({"threadId":thread}), |m| {
                m.agent.status = "uncertain".into();
            }).await?;
        let result = connection
            .rpc
            .request(
                "turn/start",
                params,
            )
            .await;
        let owned = self.owner(id).await;
        let current = same_generation(self.rpcs.lock().unwrap().get(id), connection.generation);
        match result {
            Ok(r) => {
                if !current || r["turn"]["id"].as_str().is_none() {
                    let e = OutcomeUnknown(
                        "任务已接受，但连接已结束；请恢复原会话确认结果，不要重复发送".into(),
                    )
                    .into();
                    let (agent, error) = (id.to_owned(), failure(&e));
                    if self.stored_owned(owned, move |store| Ok(record_failure(store, &agent, &error))).await? {
                        self.changed(id);
                    }
                    return Err(e);
                }
                // Some servers send turn/started before the RPC response; merge by id.
                let (agent, accepted) = (id.to_owned(), r.clone());
                self.stored_owned(owned, move |store| store
                    .record_applied(&agent, "turn/accepted", "turn/started", &accepted)).await?;
                self.changed(id);
                Ok(json!({"turnId":r["turn"]["id"]}))
            }
            Err(e) => {
                let e = if e.downcast_ref::<RpcError>().is_none() && e.downcast_ref::<OutcomeUnknown>().is_none() {
                    OutcomeUnknown(format!("任务提交结果无法确认：{e}；请核对原会话，不要重复发送")).into()
                } else { e };
                let rejected = e.downcast_ref::<RpcError>().is_some();
                let (agent, error) = (id.to_owned(), failure(&e));
                let recorded = self.stored_owned(owned, move |store| {
                    if rejected {
                        store.update(
                            &agent,
                            "turn/rejected",
                            &json!({"message":error.to_string()}),
                            |d| {
                                if d.agent.status == "uncertain" {
                                    d.agent.status = "error".into();
                                }
                            },
                        )?;
                    }
                    Ok(record_failure(store, &agent, &error))
                }).await?;
                if recorded { self.changed(id); }
                Err(e)
            }
        }
    }

    async fn confirm_previous_turn(self: &Arc<Self>, id: &str, detail: &AgentDetail) -> Result<()> {
        if detail.agent.status == "uncertain" || (detail.agent.status == "offline"
            && detail.turns.iter().any(|t| t["status"] == "inProgress")) {
            if let Err(e) = self.reconcile(id).await {
                self.failed(id, &e).await;
                return Err(e);
            }
            bail!("已重新核对原会话；本次消息没有发送。请查看恢复的执行结果，再决定是否发送新任务");
        }
        Ok(())
    }

    async fn admit_message(self: &Arc<Self>, id: &str, input: &MessageInput, detail: &AgentDetail) -> Result<()> {
        self.ensure_rewind_settled(id).await?;
        if detail.agent.harness == "opencode" {
            return self.opencode_admit(id, input, detail).await;
        }
        if detail.agent.harness == "claude" {
            if input.clarification.is_some() { return self.claude_admit_form(id).await; }
            if input.expected_turn_id.is_none() {
                return self.claude_admit_message(id).await;
            }
        }
        if self.collaboration_status(id).await.is_some_and(|s| !s.ready) {
            self.require_collaboration(id).await?;
        }
        if input.question.is_some() || input.clarification.is_some() || input.expected_turn_id.is_none() {
            if input.question.is_none() {
                // An automatic attach must not erase the original check-only
                // recovery rule for an offline/uncertain previous Turn.
                self.confirm_previous_turn(id, detail).await?;
            }
            self.ensure(id).await?;
        }
        // Steer requires an existing connection; start/answer may first attach
        // and probe an offline session. All of this precedes message/requested.
        self.require_collaboration(id).await
    }

    pub async fn send_message(self: &Arc<Self>, id: &str, input: MessageInput) -> Result<MessageReceipt> {
        self.send_message_with_skills(id, input, Vec::new()).await
    }

    /// A message that also invokes Codex skills the Agent's Codex listed
    /// (`codex_skills`): typed `skill` items after its text, kept on its
    /// receipt beside the input.
    pub async fn send_message_with_skills(self: &Arc<Self>, id: &str, input: MessageInput, skills: Vec<SkillRef>) -> Result<MessageReceipt> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        // A receipt is the only evidence this id was submitted, so it is
        // looked up first, before anything that depends on the Agent's state.
        // A read failure, or this id with other content, is a plain error:
        // the first send may have gone, and the client keeps its id.
        let detail = self.send_view(id).await?;
        if let Some(previous) = detail.message_receipts.iter().find(|r| r.input.client_message_id == input.client_message_id) {
            if previous.input != input || previous.skills != skills { bail!("同一消息编号不能提交不同的内容"); }
            return Ok(previous.clone());
        }
        // No receipt: nothing is sent before message/requested is recorded,
        // so every refusal up to there says so. The client keeps its draft
        // and shows no delivery to confirm.
        let admitted = async {
            if (input.text.trim().is_empty() && input.images.is_empty()) || input.text.len() > 100_000 || input.images.len() > crate::input_images::MAX_IMAGES
                || input.client_message_id.is_empty() || input.client_message_id.len() > 100 {
                bail!("消息或消息编号无效");
            }
            crate::message_content::validate(&input)?;
            crate::codex_skills::check(&skills)?;
            ensure_agent_open(&detail.agent)?;
            anyhow::ensure!(skills.is_empty() || (detail.agent.harness == "codex" && input.question.is_none() && input.clarification.is_none()),
                "Skills are sent only to a Codex Agent, in a new or follow-up message");
            let claude = detail.agent.harness == "claude";
            anyhow::ensure!(input.clarification.is_none() || (input.question.is_none() && input.images.is_empty()),
                "Submit form answers separately from image attachments and native questions");
            if !input.images.is_empty() { crate::input_images::supported(&detail.agent)?; }
            anyhow::ensure!(!claude || input.question.is_none(), "Claude answers in the conversation");
            if let Some(form) = &input.clarification {
                let previous = detail.message_receipts.iter().any(|r| r.status != "rejected" && r.input.clarification.as_ref()
                    .is_some_and(|a| a.result_id == form.result_id && a.form_id == form.form_id));
                if previous {
                    bail!("Answers to this form were already submitted. Check delivery; they were not sent again");
                }
                self.validate_clarification(&detail.agent, form, &input.text).await?;
            }
            // A Claude follow-up queued at Claude was sent; only a send whose
            // outcome is unknown holds the next one back.
            if detail.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain")) {
                bail!("上一条消息的发送结果尚未确认，请先重连核对；不会自动重复发送");
            }
            if let Some(source) = &input.question {
                let exists = detail.turns.iter().find(|t| t["id"].as_str() == Some(&source.turn_id))
                    .and_then(|t| t["items"].as_array()).is_some_and(|items| items.iter().any(|item|
                        item["id"].as_str() == Some(&source.item_id) && item["type"] == "agentMessage"
                        && item["delivery"] == "async" && item["questions"].as_array().is_some_and(|q| !q.is_empty())));
                if !exists { bail!("原问题已不存在，未发送回答"); }
                if detail.message_receipts.iter().any(|r| r.input.question.as_ref() == Some(source) && r.status != "rejected") {
                    bail!("这条问题的回答已提交；不会重复发送");
                }
            }
            // A Claude follow-up goes only to a turn of yours still running. A
            // draft kept for one that has since ended was never sent; sending
            // it again starts from the conversation as it is now.
            if let (true, None, Some(expected)) = (claude, &input.clarification, &input.expected_turn_id) {
                anyhow::ensure!(!crate::claude::native_turn(expected)
                    && detail.turns.iter().any(|t| t["id"] == expected.as_str() && t["status"] == "inProgress"),
                    "原 Turn 已结束或发生变化；消息仍保留，请确认后作为新消息发送");
            }
            if !claude && detail.agent.harness != "opencode" {
                let agent = id.to_owned();
                self.stored(move |store| store.activate_codex_import(&agent)).await?;
            }
            self.admit_message(id, &input, &detail).await?;
            if !skills.is_empty() {
                // On the connection the message goes out on, for the Agent's
                // own folder: each skill as chosen, still listed and on.
                let connection = self.rpcs.lock().unwrap().get(id).cloned()
                    .context("No connection to this Agent's Codex; the message was not sent")?;
                crate::codex_skills::verify(&connection.rpc, &detail.agent.cwd, &skills).await?;
            }
            if let Some(form) = &input.clarification {
                self.validate_clarification(&self.detail(id).await?.agent, form, &input.text).await?;
            }
            Ok::<_, anyhow::Error>(claude)
        }.await;
        let claude = match admitted {
            Ok(claude) => claude,
            Err(error) if error.is::<crate::collaboration_credentials::MessageNotSubmitted>() => return Err(error),
            Err(error) => return Err(crate::collaboration_credentials::MessageNotSubmitted(error).into()),
        };
        let receipt = MessageReceipt { binding: None, input: input.clone(), skills: skills.clone(), status: "sending".into(), turn_id: None, error: None };
        self.record_meta(id, "message/requested", serde_json::to_value(&receipt)?, move |m| m.message_receipts.push(receipt)).await?;
        self.changed(id);
        let result = if detail.agent.harness == "opencode" {
            self.opencode_send_locked(id, input.text.clone(), Some(&input.client_message_id)).await
        } else if claude && (input.clarification.is_some() || input.expected_turn_id.is_none()) {
            self.claude_answer_form_locked(id, &input).await
        } else if input.question.is_some() || input.clarification.is_some() {
            self.answer_locked(id, &input).await
        } else if let Some(expected) = &input.expected_turn_id {
            if claude {
                self.claude_steer_locked(id, &input.text, expected, &input.client_message_id, &input.images).await
            } else {
                self.steer_images_locked(id, &input.text, expected, &input.client_message_id, &input.images, &skills).await
            }
        } else {
            self.send_images_locked(id, input.text.clone(), Some(&input.client_message_id), &input.images, &skills).await
        };
        let (status, turn_id, error) = match result {
            // Queued at Claude, not yet confirmed: a turn naming its uuid confirms it.
            Ok(value) if value["queued"] == true => ("queued", value["turnId"].as_str().map(str::to_owned), None),
            Ok(value) => ("accepted", value["turnId"].as_str().map(str::to_owned), None),
            Err(error) => {
                let unknown = error.downcast_ref::<OutcomeUnknown>().is_some();
                (if unknown { "uncertain" } else { "rejected" }, None, Some(error.to_string()))
            }
        };
        let client_message_id = input.client_message_id.clone();
        let data = json!({"clientMessageId":input.client_message_id,"status":status,"turnId":turn_id,"error":error});
        let (agent, picked) = (id.to_owned(), input.client_message_id.clone());
        // Only this receipt is returned, as this commit left it (bound to its
        // native item if that arrived), without copying the rest of the record.
        let receipt = self.stored(move |store| store.update_picking_meta(&agent, "message/receipt", &data, move |m| {
            let receipt = m.message_receipts.iter_mut().find(|r| r.input.client_message_id == client_message_id).unwrap();
            // A native item can confirm delivery before the RPC times out, and
            // a Claude connection can end (unknown) before its reply is recorded.
            if !matches!(receipt.status.as_str(), "accepted" | "unknown") {
                receipt.status = status.into(); receipt.error = error;
                // A Claude follow-up may already be running as its own turn.
                if receipt.turn_id.is_none() { receipt.turn_id = turn_id; }
            }
        }, move |d| d.message_receipts.iter().find(|r| r.input.client_message_id == picked).cloned())).await?;
        self.changed(id);
        Ok(receipt.unwrap())
    }

    async fn answer_locked(self: &Arc<Self>, id: &str, input: &MessageInput) -> Result<Value> {
        // Async questions outlive their originating Turn. Read native state at
        // submission instead of trusting the browser's last inProgress snapshot.
        self.reconcile(id).await?;
        let detail = self.send_view(id).await?;
        if let Some(receipt) = detail.message_receipts.iter().find(|r|
            r.input.client_message_id == input.client_message_id && r.status == "accepted") {
            return Ok(json!({"turnId":receipt.turn_id}));
        }
        let active = detail.turns.iter().rev().find(|t| t["status"] == "inProgress")
            .and_then(|t| t["id"].as_str());
        if let Some(turn) = active {
            let result = self.steer_images_locked(id, &input.text, turn, &input.client_message_id, &input.images, &[]).await;
            let rejected_as_finished = result.as_ref().err().and_then(|e| e.downcast_ref::<RpcError>())
                .is_some_and(|e| e.code == -32600 && e.message == "no active turn to steer");
            if !rejected_as_finished { return result; }
            // This exact native rejection proves the answer was not consumed.
            // A timeout or transport failure must never take this fallback.
            self.reconcile(id).await?;
            if turn_busy(&self.send_view(id).await?) {
                bail!("原 Turn 刚结束，会话状态仍在更新。回答已保留，请稍后重试");
            }
        }
        self.send_images_locked(id, input.text.clone(), Some(&input.client_message_id), &input.images, &[]).await
    }

    pub(crate) async fn steer_locked(self: &Arc<Self>, id: &str, text: &str, expected: &str, client_id: &str) -> Result<Value> {
        self.steer_images_locked(id, text, expected, client_id, &[], &[]).await
    }

    async fn steer_images_locked(self: &Arc<Self>, id: &str, text: &str, expected: &str, client_id: &str, images: &[String], skills: &[SkillRef]) -> Result<Value> {
        let detail = self.send_view(id).await?;
        ensure_agent_open(&detail.agent)?;
        if detail.agent.connection_state != "connected" || matches!(detail.agent.status.as_str(), "offline" | "uncertain") {
            bail!("连接或执行结果尚未确认，请先重连核对；补充消息未发送");
        }
        if !detail.turns.iter().any(|t| t["id"] == expected && t["status"] == "inProgress") {
            bail!("原 Turn 已结束或发生变化；消息仍保留，请确认后作为新消息发送");
        }
        let connection = self.rpcs.lock().unwrap().get(id).cloned().context("连接已断开，补充消息未发送")?;
        self.require_collaboration(id).await?;
        let mut input = if images.is_empty() { json!([{"type":"text","text":text}]) }
            else { self.image_input(id, &detail.agent, &connection, text, images).await? };
        if let Some(input) = input.as_array_mut() { input.extend(crate::codex_skills::input_items(skills)); }
        anyhow::ensure!(same_generation(self.rpcs.lock().unwrap().get(id), connection.generation),
            "连接已变化，补充消息未发送；草稿保留");
        let result = connection.rpc.request("turn/steer", json!({
            "threadId":detail.agent.thread_id, "expectedTurnId":expected,
            "clientUserMessageId":client_id, "input":input
        })).await;
        match result {
            Ok(value) => {
                if !same_generation(self.rpcs.lock().unwrap().get(id), connection.generation) || value["turnId"] != expected {
                    return Err(OutcomeUnknown("补充消息的结果需要重新确认；不会自动重发".into()).into());
                }
                Ok(value)
            }
            Err(error) if error.downcast_ref::<RpcError>().is_none() && error.downcast_ref::<OutcomeUnknown>().is_none() =>
                Err(OutcomeUnknown(format!("补充消息的结果无法确认：{error}；不会自动重发")).into()),
            Err(error) => Err(error),
        }
    }

    async fn image_input(self: &Arc<Self>, id: &str, agent: &Agent, connection: &Connection, text: &str, images: &[String]) -> Result<Value> {
        crate::input_images::supported(agent)?;
        crate::input_images::check_model(&model_catalog(connection).await?, &agent.model)?;
        if let Some(remote) = &agent.remote {
            let workspace = self.stored(|store| store.workspace_id()).await?;
            let instance = &remote.runtime.as_ref().context("远程运行实例尚未确认，图片未发送")?.instance_id;
            let refs = crate::remote_images::transfer(self.data_dir.clone(), &workspace, agent,
                connection.generation, instance, images).await?;
            let current = self.detail(id).await?.agent;
            anyhow::ensure!(same_generation(self.rpcs.lock().unwrap().get(id), connection.generation)
                && crate::remote_images::destination(agent) == crate::remote_images::destination(&current),
                "远程图片目标已变化，消息未发送；草稿保留");
            let mut input = vec![];
            if !text.is_empty() { input.push(json!({"type":"text","text":text})); }
            input.extend(refs.into_iter().map(|image| json!({"type":"localImage","path":image["path"]})));
            return Ok(input.into());
        }
        let (root, id, text, images) = (self.data_dir.clone(), id.to_owned(), text.to_owned(), images.to_vec());
        tokio::task::spawn_blocking(move || crate::input_images::native_input(&root, &id, &text, &images)).await?
    }

    pub async fn agent_catalog(self: &Arc<Self>, id: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        // The Agent as listed, not its history (T-140); read again once
        // connected, for the settings the connection may have changed.
        let agent = self.listed(id).await?;
        ensure_agent_open(&agent)?;
        anyhow::ensure!(agent.harness == "codex", "此模型目录仅适用于 Codex；Claude 模型在创建时选择");
        let connection = self.settings_connection(id).await?;
        let models = model_catalog(&connection).await?;
        let agent = self.listed(id).await?;
        let permissions = permission_catalog(&connection, &agent).await;
        let context = self.context_catalog(id, &connection).await;
        Ok(json!({"models":models,"permissions":permissions,"context":context}))
    }

    /// What the context settings show: from the send view, which has the
    /// Agent, its pending requests, receipts, context usage and each Turn's
    /// status (all `codex_context::idle` reads), without the Items (T-140).
    async fn context_catalog(&self, id: &str, connection: &Connection) -> Value {
        let Ok(detail) = self.send_view(id).await else { return json!({"supported":false}); };
        let response = connection.rpc.request("config/read", json!({"cwd":detail.agent.cwd,"includeLayers":false})).await;
        let config = response.as_ref().ok().map(|r| &r["config"]).unwrap_or(&Value::Null);
        let confirmed = self.codex_context.submitted(id, connection.generation, &detail.agent.settings);
        let rewind_settled = self.ensure_rewind_settled(id).await.is_ok();
        json!({
            "supported":crate::codex_context::capability(config),
            "inheritedContextWindow":config["model_context_window"].as_u64(),
            "inheritedAutoCompactTokenLimit":config["model_auto_compact_token_limit"].as_u64(),
            "settingsSubmitted":confirmed,
            "requestedWindowTokens":detail.agent.settings.context_window,
            "canApply":rewind_settled && crate::codex_context::idle(&detail) && !detail.turns.is_empty(),
            "needsFirstTurn":detail.turns.is_empty(),
            "needsReconnect":self.codex_context.needs_resume(id, connection.generation),
            "observedWindowTokens":detail.context_usage.as_ref().map(|u| u.window_tokens),
            "observedStale":detail.context_usage.as_ref().is_some_and(|u| u.stale) || !confirmed,
        })
    }

    /// Explicitly unsubscribe and resume the SAME idle thread. Native Codex
    /// reloads unobserved idle threads when resume supplies config overrides.
    /// No interrupt, fork, new thread, global config write or app-server stop.
    pub async fn apply_codex_context(self: &Arc<Self>, id: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        self.ensure_rewind_settled(id).await?;
        let detail = self.detail(id).await?;
        ensure_agent_open(&detail.agent)?;
        anyhow::ensure!(detail.agent.harness == "codex", "仅 Codex 支持上下文配置");
        anyhow::ensure!(crate::codex_context::idle(&detail), "请等待当前轮次、审批和待确认消息结束，再应用上下文设置");
        anyhow::ensure!(!detail.turns.is_empty(), "全新空会话还没有可恢复的轮次；设置已保存，请先完成首轮，再应用上下文设置");
        let connection = self.ensure(id).await?;
        crate::codex_context::check(&connection.rpc, &detail.agent.cwd, &detail.agent.settings).await?;
        let thread = detail.agent.thread_id.as_deref().context("原会话 ID 未确认；不会创建新会话")?;
        let native = connection.rpc.request("thread/read", json!({"threadId":thread,"includeTurns":false})).await?;
        anyhow::ensure!(native["thread"]["id"] == thread && native["thread"]["status"]["type"] == "idle",
            "Codex 尚未确认原会话空闲；设置已保存，未重新加载");
        if let Some(events) = &connection.events { events.drain().await?; }
        anyhow::ensure!(crate::codex_context::idle(&self.detail(id).await?), "当前轮次或审批尚未结束；未重新加载");
        let next = self.resume_context(id, connection, true).await?;
        self.changed(id);
        Ok(self.context_catalog(id, &next).await)
    }

    /// Retry only after a known rejection, on the same app-server and thread.
    /// Settings reads/edits remain available so a rejected override can be fixed.
    async fn settings_connection(self: &Arc<Self>, id: &str) -> Result<Connection> {
        let existing = self.rpcs.lock().unwrap().get(id).cloned();
        if let Some(connection) = existing {
            if self.codex_context.needs_resume(id, connection.generation)
                && connection.attachment.lock().await.is_none() {
                return Ok(connection);
            }
        }
        self.ensure(id).await
    }

    async fn resume_context(self: &Arc<Self>, id: &str, connection: Connection, unsubscribe: bool) -> Result<Connection> {
        let detail = self.detail(id).await?;
        let thread = detail.agent.thread_id.as_deref().context("原会话 ID 未确认；不会创建新会话")?;
        crate::codex_context::check(&connection.rpc, &detail.agent.cwd, &detail.agent.settings).await?;
        // Native idle-thread resume cold-loads config only after the last
        // subscriber leaves. Keep the app-server alive; it may own children.
        // A resume ACK proves submission, never the provider's effective limit.
        let initial_params = permission_params(&connection, &detail.agent, start_params(&detail.agent), false).await?;
        let initial_params = self.collaboration_codex_params(&detail.agent, initial_params).await?;
        let initial_params = crate::results::with_capability_notice(&connection.rpc, &detail.agent.cwd, initial_params).await;
        let initial_params = crate::brief_turns::with_hard_rules(self, id, initial_params).await;
        let agent_id = id.to_owned();
        let imported = self.stored(move |store| store.is_codex_import(&agent_id)).await?;
        let mut params = resume_params(thread, &detail.agent);
        if imported { params["excludeTurns"] = true.into(); }
        for (key, value) in initial_params.as_object().unwrap() { params[key] = value.clone(); }
        if unsubscribe {
            let response = connection.rpc.request("thread/unsubscribe", json!({"threadId":thread})).await?;
            anyhow::ensure!(response["status"] == "unsubscribed" || response["status"] == "notSubscribed" || response["status"] == "notLoaded",
                "Codex 未确认取消订阅；设置尚未应用");
        }
        // Record this obligation before any fallible work after unsubscribe.
        // A live transport alone no longer proves the thread is attached.
        self.codex_context.require_resume(id, connection.generation);
        self.codex_context.awaiting_fresh_usage(id, connection.generation);
        self.update_record(id, "codex/contextReload", json!({"threadId":thread}), |d| {
            d.context_usage = None;
            d.agent.connection_state = "unconfirmed".into();
        }).await?;
        let before = self.detail(id).await?;
        let reply = connection.rpc.begin_request("thread/resume", params).await?;
        *connection.attachment.lock().await = Some(Attachment {
            agent: detail.agent.clone(), request_seq: before.agent.last_seq, request_rev: before.agent.rev,
            before, imported, new_empty_thread: false, replacing_empty_thread: false,
            same_thread_only: true, initial_params, reply,
        });
        self.finish_attach(id, connection).await
    }

    pub async fn update_settings(self: &Arc<Self>, id: &str, model: String, mut settings: AgentSettings) -> Result<Agent> {
        let _permit = self.admission.enter_work()?;
        validate_settings(&settings)?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let agent = self.detail(id).await?.agent;
        ensure_agent_open(&agent)?;
        anyhow::ensure!(agent.harness == "codex", "Claude 当前不支持 Codex 推理强度或权限设置；现有 Session 保持原配置");
        // Clearing only the saved context overrides is an offline recovery
        // action. It must work even when the runtime/catalog cannot load, and
        // must not change permissions, model or effort through this bypass.
        let mut automatic = agent.settings.clone();
        automatic.context_window = None;
        automatic.auto_compact_token_limit = None;
        if crate::codex_context::Overrides::from(&agent.settings).custom()
            && model == agent.model && settings == automatic {
            let owned = self.owner(id).await;
            let agent = id.to_owned();
            let detail = self.stored_owned(owned, move |store| store.update(&agent, "agent/settings",
                &json!({"model":model,"settings":settings}), |d| {
                    // Preserve the latest unrelated fields, including any
                    // effort learned from a concurrent native notification.
                    d.agent.settings.context_window = None;
                    d.agent.settings.auto_compact_token_limit = None;
                    if let Some(usage) = &mut d.context_usage { usage.stale = true; }
                })).await?;
            self.changed(id);
            return Ok(detail.agent);
        }
        let connection = self.settings_connection(id).await?;
        let catalog = model_catalog(&connection).await?;
        let selected = catalog.iter().find(|m| m["model"].as_str() == Some(model.trim()) || m["id"].as_str() == Some(model.trim()))
            .context("请选择当前 Agent 的执行机器提供的模型")?;
        let effort = settings.reasoning_effort.as_deref().or_else(|| selected["defaultReasoningEffort"].as_str()).context("模型未提供推理强度")?;
        if !selected["supportedReasoningEfforts"].as_array().is_some_and(|efforts| efforts.iter().any(|e| e["reasoningEffort"] == effort)) {
            bail!("该模型不支持所选推理强度");
        }
        settings.reasoning_effort = Some(effort.into());
        crate::codex_context::check(&connection.rpc, &agent.cwd, &settings).await?;

        if settings.permission_preset.is_some() {
            let agent = self.detail(id).await?.agent;
            let (config, requirements) = permission_config(&connection.rpc, &agent.cwd).await?;
            permissions::resolve(&settings, &config, &agent.cwd)?.check_requirements(&requirements)?;
        }
        let model = selected["model"].as_str().or_else(|| selected["id"].as_str()).context("模型编号缺失")?.to_owned();
        let owned = self.owner(id).await;
        if !same_generation(self.rpcs.lock().unwrap().get(id), connection.generation) { bail!("连接已变化，设置未保存，请重试"); }
        let agent = id.to_owned();
        let detail = self.stored_owned(owned, move |store| store.update(&agent, "agent/settings", &json!({"model":model,"settings":settings}), |d| {
            if d.agent.model != model || crate::codex_context::Overrides::from(&d.agent.settings) != crate::codex_context::Overrides::from(&settings) {
                if let Some(usage) = &mut d.context_usage { usage.stale = true; }
            }
            d.agent.model = model;
            d.agent.settings = settings;
        })).await?;
        self.changed(id);
        Ok(detail.agent)
    }

    /// The user's explicit `/compact` for a Codex Agent: Codex's own context
    /// compaction of this thread (`thread/compact/start`), never a prompt.
    /// It runs only between turns, on the connection already serving this
    /// thread: nothing is connected, resumed, retried or reconciled for it,
    /// and an unconfirmed earlier send or turn refuses it.
    ///
    /// Codex's empty answer only accepts the request. The Agent stays
    /// uncertain from before the request until Codex's own events for the
    /// thread (its compaction turn) say otherwise, so neither a second
    /// `/compact` nor a message can slip in; a lost answer leaves it
    /// uncertain, to be checked, never sent again. Only a Codex without the
    /// method (JSON-RPC -32601, refused before anything runs) provably ran
    /// nothing; any other error says nothing about whether it had begun, so
    /// the Agent stays uncertain too. A state Codex's own events already set
    /// is never rolled back.
    pub async fn codex_compact(self: &Arc<Self>, id: &str) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (detail, thread, connection) = self.idle_codex_thread(id, "/compact").await?;
        let before = detail.agent.status.clone();
        self.record_meta(id, "compact/requested", json!({"threadId":thread,"generation":connection.generation}), |m| {
            m.agent.status = "uncertain".into();
        }).await?;
        self.changed(id);
        let result = connection.rpc.request("thread/compact/start", json!({"threadId":thread})).await;
        let current = same_generation(self.rpcs.lock().unwrap().get(id), connection.generation);
        match result {
            Ok(_) if current => Ok(json!({"accepted":true,"threadId":thread})),
            Ok(_) => bail!("Codex 接受了 /compact，但连接随后已变化；请重新连接核对结果，不要重复执行"),
            Err(error) => match error.downcast_ref::<RpcError>() {
                // An unknown method is refused before any handler runs:
                // nothing ran, so the Agent is as it was, unless Codex's own
                // events have said otherwise meanwhile.
                Some(refused) if refused.code == -32601 => {
                    let message = "这台机器上的 Codex 不提供原生压缩（thread/compact/start）；没有执行".to_owned();
                    self.record_meta(id, "compact/rejected", json!({"message":message,"code":refused.code}), move |m| {
                        if m.agent.status == "uncertain" { m.agent.status = before; }
                    }).await?;
                    self.changed(id);
                    bail!(message)
                }
                // Any other error doesn't show whether Codex had begun: the
                // Agent stays as its events leave it, uncertain until checked.
                Some(refused) => {
                    let message = format!("Codex 对 /compact 返回了错误：{}；是否已开始压缩无法确认，请重新连接核对，不要重复执行", refused.message);
                    self.record_meta(id, "compact/failed", json!({"message":message,"code":refused.code}), |_| {}).await?;
                    self.changed(id);
                    bail!(message)
                }
                None => bail!("/compact 的结果无法确认：{error}；请重新连接核对，不要重复执行"),
            },
        }
    }

    /// For a native Codex control that runs only between turns (`what`, as
    /// typed), with this Agent's gate held: its thread and the connection
    /// already serving it. Nothing is connected, resumed, retried or
    /// reconciled for it, and an unconfirmed earlier send, control or turn
    /// refuses it.
    pub(crate) async fn idle_codex_thread(&self, id: &str, what: &str) -> Result<(AgentDetail, String, Connection)> {
        self.ensure_rewind_settled(id).await?;
        let detail = self.send_view(id).await?;
        ensure_agent_open(&detail.agent)?;
        anyhow::ensure!(detail.agent.harness == "codex", "Claude 的 {what} 是原生命令：作为消息发送，由 Claude Code 自己执行");
        let thread = detail.agent.thread_id.clone().with_context(|| format!("会话 ID 尚未确认；没有执行 {what}"))?;
        if detail.agent.status == "uncertain"
            || detail.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain")) {
            bail!("上一次发送、执行、/compact 或 /review 的结果尚未确认；请先重新连接核对，没有执行 {what}");
        }
        if turn_busy(&detail) || detail.turns.iter().any(|t| t["status"] == "inProgress") {
            bail!("当前 Turn 尚未结束或正在等待回应；没有执行 {what}");
        }
        let connection = self.rpcs.lock().unwrap().get(id).cloned()
            .filter(|c| !c.closing && detail.agent.connection_state == "connected")
            .with_context(|| format!("没有连接到这个原生会话；请先重新连接，没有执行 {what}"))?;
        anyhow::ensure!(connection.attachment.lock().await.is_none() && !self.codex_context.needs_resume(id, connection.generation),
            "原生会话正在接续；完成后再执行 {what}");
        anyhow::ensure!(same_generation(self.rpcs.lock().unwrap().get(id), connection.generation), "连接已变化；没有执行 {what}");
        Ok((detail, thread, connection))
    }

    /// The user's explicit `/review` for a Codex Agent: Codex's own code
    /// review of `target` (`review/start`), delivered inline as a Turn of
    /// this thread, never a prompt. As `/compact`, it runs only between
    /// turns on the connection already serving the thread (see
    /// `idle_codex_thread`), and the Agent is uncertain from before the
    /// request until Codex settles it: its answer is the review's Turn,
    /// recorded as started (as `turn/start`'s is), and the Turn's own events
    /// carry it on. Detached delivery, a new thread for the review, is not
    /// used: Codex has deprecated it.
    ///
    /// Only a Codex without the method (JSON-RPC -32601) provably ran
    /// nothing. Any other error, a lost answer, or an answer without its Turn
    /// leaves the Agent uncertain, to be checked by reconnecting, never sent
    /// again.
    pub async fn codex_review(self: &Arc<Self>, id: &str, target: ReviewTarget) -> Result<Value> {
        let target = target.checked()?;
        let _permit = self.admission.enter_work()?;
        let gate = self.gate(id).await;
        let _held = gate.lock().await;
        let (detail, thread, connection) = self.idle_codex_thread(id, "/review").await?;
        let before = detail.agent.status.clone();
        self.record_meta(id, "review/requested", json!({"threadId":thread,"generation":connection.generation,"target":target}), |m| {
            m.agent.status = "uncertain".into();
        }).await?;
        self.changed(id);
        let result = connection.rpc.request("review/start", json!({"threadId":thread,"target":target,"delivery":"inline"})).await;
        let current = same_generation(self.rpcs.lock().unwrap().get(id), connection.generation);
        match result {
            Ok(r) if current && r["turn"]["id"].is_string() => {
                // Its events may come first; merged by the Turn's ID.
                let owned = self.owner(id).await;
                let (agent, accepted) = (id.to_owned(), json!({"turn":r["turn"]}));
                self.stored_owned(owned, move |store| store.record_applied(&agent, "turn/accepted", "turn/started", &accepted)).await?;
                self.changed(id);
                Ok(json!({"accepted":true,"threadId":thread,"turnId":r["turn"]["id"]}))
            }
            Ok(_) => bail!("Codex 接受了 /review，但连接随后已变化或没有给出它的 Turn；请重新连接核对结果，不要重复执行"),
            Err(error) => match error.downcast_ref::<RpcError>() {
                Some(refused) if refused.code == -32601 => {
                    let message = "这台机器上的 Codex 不提供原生审查（review/start）；没有执行".to_owned();
                    self.record_meta(id, "review/rejected", json!({"message":message,"code":refused.code}), move |m| {
                        if m.agent.status == "uncertain" { m.agent.status = before; }
                    }).await?;
                    self.changed(id);
                    bail!(message)
                }
                Some(refused) => {
                    let message = format!("Codex 对 /review 返回了错误：{}；是否已开始审查无法确认，请重新连接核对，不要重复执行", refused.message);
                    self.record_meta(id, "review/failed", json!({"message":message,"code":refused.code}), |_| {}).await?;
                    self.changed(id);
                    bail!(message)
                }
                None => bail!("/review 的结果无法确认：{error}；请重新连接核对，不要重复执行"),
            },
        }
    }

    pub async fn interrupt(&self, id: &str) -> Result<()> {
        let _permit = self.admission.enter_completion()?;
        // The harness is the Agent's, and the Turn to stop is found by its
        // status: the listed Agent and the send view, not the history (T-140).
        match self.listed(id).await?.harness.as_str() {
            "claude" => return self.claude_interrupt(id).await,
            "opencode" => return self.opencode_interrupt(id).await,
            _ => {}
        }
        let d = self.send_view(id).await?;
        ensure_agent_open(&d.agent)?;
        let turn = d
            .turns
            .iter()
            .rev()
            .find(|t| t["status"] == "inProgress")
            .context("没有正在执行的 Turn")?;
        let connection = self
            .rpcs
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .context("连接已断开，无法确认中断")?;
        connection
            .rpc
            .request(
                "turn/interrupt",
                json!({"threadId":d.agent.thread_id,"turnId":turn["id"]}),
            )
            .await?;
        // The ACK is not completion. Only turn/completed changes runtime status.
        Ok(())
    }

    /// One native event, in arrival order for its connection. Only this
    /// Agent's ownership lock is taken, so Agents never wait for each other
    /// here (apart from the single SQLite writer). The lock goes with the
    /// blocking job, so the next event of this Agent, or its reconnect, starts
    /// only after this one has been recorded.
    async fn dispatch_event(self: &Arc<Self>, id: &str, generation: u64, message: Value) {
        let owned = self.owner(id).await;
        if !same_generation(self.rpcs.lock().unwrap().get(id), generation) { return; }
        if self.codex_usage_event(id, generation, &message) { return; }
        if id == "_catalog" {
            let connection = self.rpcs.lock().unwrap().get(id).cloned();
            if !same_generation(connection.as_ref(), generation) {
                return;
            }
            if message["method"] == "yuzuno/disconnected" {
                self.rpcs.lock().unwrap().remove(id);
                self.set_runtime(json!({"connected":false})).await;
            } else if let (Some(_), Some(connection)) = (message.get("id"), connection) {
                let _=connection.rpc.try_send(json!({"id":message["id"],"error":{"code":-32601,"message":"Catalog only supports read operations"}}));
            }
            return;
        }
        let (ws, id) = (self.clone(), id.to_owned());
        let permit = self.admission.enter_event();
        let handled = crate::db::blocking(move || {
            let _permit = permit;
            let _owned = owned;
            ws.on_event(&id, generation, message);
            Ok(())
        });
        if let Err(error) = handled.await {
            eprintln!("Workspace native event not handled: {error}");
        }
    }

    /// Blocking; called by `dispatch_event` with the ownership lock held.
    fn on_event(self: &Arc<Self>, id: &str, generation: u64, message: Value) {
        let method = message["method"].as_str().unwrap_or_default();
        let p = &message["params"];
        // Ownership check and store mutation are atomic with reconnect: the
        // caller holds this Agent's ownership lock.
        let connection = self.rpcs.lock().unwrap().get(id).cloned();
        if !same_generation(connection.as_ref(), generation) {
            return;
        }
        // Closed and thread are enough to check ownership; parsing the full
        // record for every event is what made long Turns fall behind.
        let Ok((closed, known_thread)) = self.store.binding(id) else { return; };
        if closed { return; }
        let event_thread = p["threadId"]
            .as_str()
            .or_else(|| p["thread"]["id"].as_str());
        let wrong_thread = known_thread
            .as_deref()
            .zip(event_thread)
            .is_some_and(|(known, event)| known != event);
        if !wrong_thread && !self.codex_context.accepts_usage_event(id, generation, method, p["turnId"].as_str()) { return; }
        let request_without_scope =
            message.get("id").is_some() && (known_thread.is_none() || event_thread.is_none());
        // A direct sub-agent's request or its resolution arrives here with the
        // child's thread. Only these two may pass the thread check, and only
        // for a child this Agent's own Turns record (T-63).
        let child_changes = method == "item/started" && p["item"]["type"] == "fileChange";
        let child = if wrong_thread
            && (message.get("id").is_some() || method == "serverRequest/resolved" || child_changes)
        {
            // Only its Items are read, not a copy of the record (T-140).
            event_thread.and_then(|thread| self.store.recorded_child(id, thread).ok().flatten())
        } else {
            None
        };
        if let Some(child) = child.as_ref().filter(|_| message.get("id").is_some()) {
            if !crate::subagents::CHILD_REQUESTS.contains(&method) {
                if let Some(connection) = &connection {
                    let _=connection.rpc.try_send(json!({"id":message["id"],"error":{"code":-32601,
                        "message":"Yuzuno only handles command and file approvals from sub-agents; no action was authorized"}}));
                }
                let path = child["path"].as_str().unwrap_or("子 Agent");
                let _ = self.store.update(id, "runtime/error", &json!({"method":method,"threadId":event_thread}), |d| {
                    d.agent.error = Some(format!(
                        "子 Agent {path} 发来 {method} 请求，已拒绝：本版只在父 Agent 中处理子 Agent 的命令和文件审批，未授权任何操作。"
                    ));
                });
                self.changed(id);
                return;
            }
        }
        if let Some(child) = child.as_ref().filter(|_| child_changes) {
            // Shown with the child's request; never part of the parent's Turns.
            let thread = child["threadId"].as_str().unwrap_or_default();
            self.child_changes.keep(id, thread, &p["item"]);
            return;
        }
        if (wrong_thread && child.is_none()) || request_without_scope {
            if message.get("id").is_some() {
                if let Some(connection) = &connection {
                    let _=connection.rpc.try_send(json!({"id":message["id"],"error":{"code":-32601,
                        "message":"This client only handles requests for its bound thread; no action was authorized"}}));
                }
                let _ = self.store.update(
                    id,
                    "runtime/error",
                    &json!({"method":method,"threadId":event_thread}),
                    |d| {
                        d.agent.error = Some(
                            "收到其他或未知会话的请求，已拒绝；本版仅支持当前 Agent 绑定的会话。"
                                .into(),
                        );
                    },
                );
                self.changed(id);
            }
            return;
        }
        if method == "yuzuno/disconnected" {
            let intentional = self.rpcs.lock().unwrap().remove(id).is_some_and(|connection| connection.closing);
            self.codex_mcp.forget(id);
            self.codex_plan.forget(id);
            // Only the metadata changes: written without copying the record
            // (T-140).
            let _ = self.store.update_meta(id, "runtime/disconnected", p, |m| {
                if let Some(usage) = m.context_usage.as_mut() { usage.stale = true; }
                m.agent.connection_state = "disconnected".into();
                if m.agent.status != "uncertain" {
                    m.agent.status = "offline".into();
                }
                if !intentional {
                    m.agent.error = Some(p["message"].as_str().unwrap_or("连接已断开").into());
                }
                for r in m.pending.iter_mut() {
                    r.stale = true;
                }
            });
        } else if message.get("id").is_some() {
            let supported = matches!(
                method,
                "item/commandExecution/requestApproval"
                    | "item/fileChange/requestApproval"
                    | "item/tool/requestUserInput"
            );
            if !supported {
                if let Some(connection) = &connection {
                    let _=connection.rpc.try_send(json!({"id":message["id"],"error":{"code":-32601,"message":"Yuzuno 尚未支持此请求，未授权任何操作"}}));
                }
                self.fail(
                    id,
                    &anyhow::anyhow!("当前客户端尚未支持请求：{method}。未授权任何操作。"),
                );
                return;
            }
            let mut params = p.clone();
            params["_rpcId"] = message["id"].clone();
            params["_runtimeGeneration"] = generation.into();
            params["_responseSent"] = false.into();
            if let Some(child) = &child {
                // Which sub-agent asks; the answer still goes to its request id.
                params["_subAgent"] = child.clone();
                let thread = child["threadId"].as_str().unwrap_or_default();
                if let Some(changes) = p["itemId"].as_str().and_then(|item| self.child_changes.take(id, thread, item)) {
                    params["_changes"] = changes;
                }
            }
            // Only the pending requests are read and written (T-120): not the
            // whole record, which a long conversation makes large.
            let replayed = self.store.pending(id).ok().and_then(|pending| pending.into_iter().find(|old|
                old.method == method && old.params["turnId"] == p["turnId"]
                    && old.params["itemId"] == p["itemId"]
                    && (p["itemId"].is_string() || old.params["_rpcId"] == message["id"])));
            if params.get("_changes").is_none() {
                // A replay after reconnect keeps what the first request showed.
                if let Some(changes) = replayed.as_ref().and_then(|old| old.params.get("_changes")) {
                    params["_changes"] = changes.clone();
                }
            }
            let request = PendingRequest {
                // A browser may still hold a button from the previous connection.
                // Rotate its action token even when the native pending operation
                // is the same; deduplicating unread evidence is separate.
                id: replayed.as_ref().filter(|r| !r.stale && r.params["_runtimeGeneration"] == generation)
                    .map(|r| r.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
                agent_id: id.into(),
                method: method.into(),
                params,
                created_at: replayed.as_ref().map(|r| r.created_at.clone()).unwrap_or_else(now),
                stale: false,
            };
            let event_kind = if replayed.is_some() { "request/replayed" } else { "request" };
            let _ = self.store.update_meta(id, event_kind, p, |d| {
                // Native replay replaces only its matching historical request.
                // Unreplayed stale approvals remain visible until the harness
                // confirms completion/resolution; reconnect is not dismissal.
                d.pending.retain(|old| !((old.stale || old.params["_runtimeGeneration"] != generation) && old.method == method
                    && old.params["turnId"] == p["turnId"]
                    && old.params["itemId"] == p["itemId"]
                    && (p["itemId"].is_string() || old.params["_rpcId"] == message["id"])));
                if !d.pending.iter().any(|r| {
                    r.params["_runtimeGeneration"] == generation
                        && r.params["_rpcId"] == message["id"]
                }) {
                    if request_blocks(&request) {
                        d.agent.status = "waiting".into();
                    }
                    d.pending.push(request);
                }
            });
        } else if method == "thread/started" {
            // Retain a recovery handle even if the thread/start response times out.
            // The Agent's thread is metadata: written without copying the
            // record (T-140).
            let _ = self.store.update_meta(id, method, p, |m| {
                if m.agent.thread_id.is_none() && p["thread"]["parentThreadId"].is_null() {
                    m.agent.thread_id = p["thread"]["id"].as_str().map(str::to_owned);
                }
            });
        } else if method == "command/exec/outputDelta" {
            // Output of a /diff read's command on this connection; not the thread's.
            self.codex_diff.deliver(id, generation, p);
        } else {
            // Its own thread's MCP servers, as they start (shown by /mcp); a
            // new thread's may report before its ID is recorded.
            if method == "mcpServer/startupStatus/updated" && event_thread.is_some()
                && known_thread.as_deref().is_none_or(|known| Some(known) == event_thread) {
                self.codex_mcp.observe(id, generation, p);
            }
            // Its own thread's settings, with the mode /plan shows.
            if method == "thread/settings/updated" && known_thread.is_some() && known_thread.as_deref() == event_thread
                && self.codex_plan.report(id, generation, &p["threadSettings"]["collaborationMode"], "settings") {
                self.changed(id);
            }
            match crate::store::route(method, p) {
                crate::store::Route::Synchronous => {
                    let mut scoped = p.clone();
                    if method == "serverRequest/resolved" {
                        scoped["_runtimeGeneration"] = generation.into();
                    }
                    // A resolution and a thread status change only the Agent and
                    // its pending requests, and an MCP server's startup status
                    // changes no field at all; beside a receipt sending or
                    // uncertain accept receipts by the Turns as `apply` does:
                    // committed as metadata, without copying a long record
                    // (T-120, T-140). The kinds
                    // a send waits behind, whose rows `Dirty::of_applied` names (verified
                    // against apply_at), are not compared; others are. A
                    // Turn's end is written in place on a held record, and
                    // compared otherwise (`Store::record_applied`, T-140).
                    let _ = if let Some((running, unconfirmed)) = self.metadata_event(id, method) {
                        let change = |m: &mut crate::store::Meta<'_>| apply_metadata_event(m, method, &scoped, running);
                        if unconfirmed {
                            self.store.update_meta_applied(id, method, &scoped, change)
                        } else {
                            self.store.update_meta(id, method, &scoped, change)
                        }
                    } else if matches!(method, "thread/status/changed" | "turn/started" | "turn/completed"
                        | "mcpServer/startupStatus/updated") {
                        self.store.record_applied(id, method, method, &scoped)
                    } else {
                        self.store.record_event(id, method, &scoped, |d| d.apply(method, &scoped))
                    };
                }
                crate::store::Route::Ignored => return,
                route => {
                    // Applied in memory and announced by the stream ticker (or
                    // only journaled, for evidence); see store::Route. One that
                    // changed status or Turn boundaries anyway is announced now.
                    let streamed = self.store.record_stream(id, route, method, p).unwrap_or_default();
                    // perf-sse: send what it changed, still under the event
                    // (ownership) lock: no other event of this Agent between.
                    if let Some(rev) = streamed.rev { self.streamed_codex(id, method, p, rev); }
                    self.start_stream_ticker();
                    if streamed.urgent { self.changed(id); }
                    crate::background_shells::codex_event(self, id, method, p, known_thread.as_deref().or(event_thread));
                    return;
                }
            }
        }
        crate::background_shells::codex_event(self, id, method, p, known_thread.as_deref().or(event_thread));
        self.changed(id);
    }

    /// For a native event that changes only the Agent and its pending
    /// requests (`apply_metadata_event`), whether a Turn is in progress: the
    /// one fact the status it leaves reads from the Turns. And whether a
    /// receipt is sending or uncertain: then `apply`'s last step, accepting
    /// receipts by the Turns (`confirm_message_receipts`), may have work, and
    /// the commit takes it too (`Store::update_meta_applied`), as applying
    /// the event to the whole record did; otherwise, as before, it does not.
    /// An MCP server's startup status was always applied to the whole record
    /// (`record_applied`), whose last step accepts every receipt not yet
    /// accepted or rejected, so it always takes that step (T-140).
    /// None for any other event. The caller holds the ownership lock
    /// (`on_event`), so this is still so at the commit: Turns change only
    /// through this Agent's events and owned commits, and closing, which is
    /// not owned, leaves the Agent offline, whose status does not read it.
    fn metadata_event(&self, id: &str, method: &str) -> Option<(bool, bool)> {
        if !matches!(method, "serverRequest/resolved" | "thread/status/changed" | "mcpServer/startupStatus/updated") { return None; }
        let (_, activity) = self.store.update_readiness(id).ok()?;
        Some((activity.running, method == "mcpServer/startupStatus/updated" || activity.sending || activity.uncertain))
    }

    pub async fn respond(&self, request_id: &str, response: Value) -> Result<()> {
        let _permit = self.admission.enter_completion()?;
        let gate = self.gate(&format!("request:{request_id}")).await;
        let _held = gate.lock().await;
        let request = request_id.to_owned();
        let holders = self.stored(move |store| store.request_holders(&request)).await?;
        for a in holders {
            let agent_gate = self.gate(&a.id).await;
            let _agent_held = agent_gate.lock().await;
            let agent = a.id.clone();
            ensure_agent_open(&self.stored(move |store| store.agent(&agent)).await?)?;
            if a.harness == "claude" {
                if self.claude_respond(&a.id, request_id, &response).await? { return Ok(()); }
                continue;
            }
            if a.harness == "opencode" {
                if self.opencode_respond(&a.id, request_id, &response).await? { return Ok(()); }
                continue;
            }
            // Re-read Pending under the same lock as disconnect; reply and
            // record it in one job, so it cannot be left half-done.
            let owned = self.owner(&a.id).await;
            let connection = self.rpcs.lock().unwrap().get(&a.id).cloned();
            let (agent, request_id, response) = (a.id.clone(), request_id.to_owned(), response.clone());
            let sent = self.stored_owned(owned, move |store| {
                // The pending requests only, not the whole record (T-120).
                let pending = store.pending(&agent)?;
                let Some(p) = pending.iter().find(|p| p.id == request_id) else {
                    return Ok(None);
                };
                let connection = connection.context("会话已断开，请求未发送")?;
                validate_request_connection(p, connection.generation)?;
                validate_response(p, &response)?;
                store.update_meta(
                    &agent,
                    "request/replied",
                    &json!({"requestId":request_id}),
                    |d| {
                        if let Some(p) = d.pending.iter_mut().find(|p| p.id == request_id) {
                            p.params["_responseSent"] = true.into();
                        }
                    },
                )?;
                if let Err(e) = connection
                    .rpc
                    .try_send(json!({"id":p.params["_rpcId"],"result":response}))
                {
                    let _ = store.update_meta(
                        &agent,
                        "request/notSent",
                        &json!({"requestId":request_id}),
                        |d| {
                            if let Some(p) = d.pending.iter_mut().find(|p| p.id == request_id) {
                                p.params["_responseSent"] = false.into();
                            }
                        },
                    );
                    return Ok(Some(Err(e)));
                }
                Ok(Some(Ok(())))
            }).await?;
            let Some(sent) = sent else { continue };
            // Native resolution removes Pending; a queued reply only disables duplicate replies.
            self.changed(&a.id);
            return sent;
        }
        bail!("请求已失效或不存在")
    }

    pub async fn catalog(self: &Arc<Self>) -> Result<Value> {
        let _permit = self.admission.enter_work()?;
        let gate = self.gate("_catalog").await;
        let _held = gate.lock().await;
        let cached = self.rpcs.lock().unwrap().get("_catalog").cloned();
        let connection = match cached {
            Some(c) => c,
            None => self.connect("_catalog").await?,
        };
        let models = match connection.rpc.request("model/list", json!({})).await {
            Ok(models) => models,
            Err(e) => {
                self.remove_connection("_catalog", connection.generation)
                    .await;
                self.set_runtime(json!({"connected":false})).await;
                return Err(e);
            }
        };
        let account = connection
            .rpc
            .request("account/read", json!({"refreshToken":false}))
            .await;
        let _owned = self.owner("_catalog").await;
        if !same_generation(self.rpcs.lock().unwrap().get("_catalog"), connection.generation) {
            bail!("Codex 目录连接已断开，请重试");
        }
        let account = account.unwrap_or(json!({}));
        let label = account["account"]["email"]
            .as_str()
            .or_else(|| account["account"]["type"].as_str())
            .unwrap_or("未登录");
        self.set_runtime(json!({"connected":true,"account":label})).await;
        Ok(json!({"models":models["data"]}))
    }
}

pub(crate) fn same_generation(connection: Option<&Connection>, generation: u64) -> bool {
    connection.is_some_and(|c| c.generation == generation)
}

/// What `record_failure` reads of an error, for a blocking job (errors are
/// not Clone).
fn failure(error: &anyhow::Error) -> anyhow::Error {
    let message = error.to_string();
    if error.downcast_ref::<OutcomeUnknown>().is_some() {
        OutcomeUnknown(message).into()
    } else {
        anyhow::anyhow!(message)
    }
}

/// Records a runtime failure unless the Agent is closed or already shows this
/// error. Returns whether it got as far as recording (and so must announce).
/// Both the check and the write are of the Agent's fields only: a failing
/// reconnect, retried while a remote machine is away, never reads or copies
/// the history (T-140).
fn record_failure(store: &Store, id: &str, error: &anyhow::Error) -> bool {
    let Ok(agent) = store.agent(id) else { return false };
    if agent.closed_at.is_some() { return false; }
    let unknown = error.downcast_ref::<OutcomeUnknown>().is_some() || agent.status == "uncertain";
    let message = error.to_string();
    if agent.error.as_deref() == Some(&message)
        && matches!(agent.status.as_str(), "error" | "uncertain") { return false; }
    let _ = store.update_meta(
        id,
        "runtime/error",
        &json!({"message":message,"outcomeUnknown":unknown}),
        |m| {
            m.agent.status = if unknown || m.agent.status == "uncertain" {
                "uncertain"
            } else {
                "error"
            }
            .into();
            m.agent.error = Some(message);
        },
    );
    true
}

/// The resume's own fields. `ensure` adds the composed start params, the
/// developer instructions Core composed included.
fn resume_params(thread: &str, agent: &Agent) -> Value {
    let mut params = start_params(agent);
    params["threadId"] = thread.into();
    params.as_object_mut().unwrap().remove("developerInstructions");
    params
}

fn start_params(agent: &Agent) -> Value {
    let mut params = json!({"cwd":agent.cwd});
    if agent.settings.permission_preset.as_deref() != Some("config") {
        if let Ok(permissions) = permissions::resolve(&agent.settings, &Value::Null, &agent.cwd) {
            permissions.apply(&mut params, false);
        }
    }
    crate::codex_context::apply(&agent.settings, &mut params);
    if !agent.model.is_empty() {
        params["model"] = agent.model.clone().into();
    }
    params
}

fn turn_params(agent: &Agent, thread: &str, text: &str, client_id: Option<&str>) -> Value {
    let mut params = json!({"threadId":thread,"input":[{"type":"text","text":text}]});
    if agent.settings.permission_preset.as_deref() != Some("config") {
        if let Ok(permissions) = permissions::resolve(&agent.settings, &Value::Null, &agent.cwd) {
            permissions.apply(&mut params, true);
        }
    }
    if !agent.model.is_empty() { params["model"] = agent.model.clone().into(); }
    if let Some(effort) = &agent.settings.reasoning_effort { params["effort"] = effort.clone().into(); }
    if let Some(id) = client_id { params["clientUserMessageId"] = id.into(); }
    params
}

fn validate_settings(settings: &AgentSettings) -> Result<()> {
    crate::codex_context::Overrides::from(settings).validate()?;
    if settings.permission_preset.as_deref().is_some_and(|mode| !["config", "ask", "auto", "full"].contains(&mode)) {
        bail!("未知的 Codex 权限模式");
    }
    if !["on-request", "untrusted", "never"].contains(&settings.approval_policy.as_str())
        || !["read-only", "workspace-write", "danger-full-access"].contains(&settings.sandbox.as_str()) {
        bail!("权限设置无效");
    }
    if settings.permission_mode.is_some() {
        bail!("Claude 权限模式不适用于 Codex");
    }
    Ok(())
}

pub(crate) async fn permission_config(rpc: &Rpc, cwd: &str) -> Result<(Value, Value)> {
    let response = rpc.request("config/read", json!({"cwd":cwd,"includeLayers":false})).await?;
    let mut config = permissions::config_from_response(&response)?;
    let response = rpc.request("configRequirements/read", json!({})).await?;
    let requirements = response["requirements"].clone();
    // A managed profile selection takes precedence over the legacy sandbox.
    if requirements["allowedPermissionProfiles"].is_object() {
        config.as_object_mut().unwrap().remove("sandbox_mode");
        if config["default_permissions"].is_null() && requirements["defaultPermissions"].is_string() {
            config["default_permissions"] = requirements["defaultPermissions"].clone();
        }
    }
    Ok((config, requirements))
}

async fn permission_params(connection: &Connection, agent: &Agent, mut params: Value, turn: bool) -> Result<Value> {
    if agent.settings.permission_preset.is_some() {
        let (config, requirements) = permission_config(&connection.rpc, &agent.cwd).await?;
        let permissions = permissions::resolve(&agent.settings, &config, &agent.cwd)?;
        permissions.check_requirements(&requirements)?;
        permissions.apply(&mut params, turn);
    } else {
        // Invalid persisted legacy settings must fail rather than inherit a
        // potentially more permissive native default.
        permissions::resolve(&agent.settings, &Value::Null, &agent.cwd)?.apply(&mut params, turn);
    }
    Ok(params)
}

async fn permission_catalog(connection: &Connection, agent: &Agent) -> Value {
    session_permission_catalog(&connection.rpc, &agent.cwd, &agent.settings).await
}

pub(crate) async fn session_permission_catalog(rpc: &Rpc, cwd: &str, settings: &AgentSettings) -> Value {
    let context = permission_config(rpc, cwd).await;
    let presets: Vec<_> = ["config", "ask", "auto", "full"].into_iter().map(|id| {
        let resolved: Result<Permissions> = (|| {
            let (config, requirements) = context.as_ref().map_err(|e| anyhow::anyhow!(e.to_string()))?;
            let mut settings = settings.clone();
            settings.permission_preset = Some(id.into());
            let resolved = permissions::resolve(&settings, config, cwd)?;
            resolved.check_requirements(requirements)?;
            Ok(resolved)
        })();
        match resolved {
            Ok(permissions) => json!({"id":id,"available":true,"permissions":permissions}),
            Err(error) => json!({"id":id,"available":false,"reason":error.to_string()}),
        }
    }).collect();
    json!({"presets":presets})
}

async fn model_catalog(connection: &Connection) -> Result<Vec<Value>> {
    let mut models = vec![];
    let mut cursor = Value::Null;
    for _ in 0..20 {
        let page = connection.rpc.request("model/list", json!({"cursor":cursor,"limit":100})).await?;
        models.extend(page["data"].as_array().context("模型目录格式无效")?.iter().cloned());
        let next = page["nextCursor"].clone();
        if next.is_null() { return Ok(models); }
        if next == cursor { bail!("模型目录分页没有前进"); }
        cursor = next;
    }
    bail!("模型目录页数超出限制")
}

fn request_blocks(p: &PendingRequest) -> bool {
    !p.stale && (p.method.ends_with("requestApproval") || p.params["isBlocking"] != false)
}

fn turn_busy(d: &AgentDetail) -> bool {
    ["working", "waiting"].contains(&d.agent.status.as_str())
        || d.pending.iter().any(request_blocks)
        || (d.agent.status != "offline" && d.turns.iter().any(|t| t["status"] == "inProgress"))
}

/// `AgentDetail::apply` of `serverRequest/resolved` or `thread/status/changed`
/// on the metadata alone, `running` standing in for the Turns (see
/// `Workspace::metadata_event`). `Store::update_meta` sets the pending count
/// and update time, and binds the receipts, as the whole-record commit does;
/// `Store::update_meta_applied`, beside a receipt sending or uncertain,
/// accepts them too.
fn apply_metadata_event(m: &mut crate::store::Meta<'_>, method: &str, p: &Value, running: bool) {
    match method {
        "serverRequest/resolved" => crate::model::resolve_request(m.pending, p),
        // Not one `AgentDetail::apply` acts on: only the status is settled
        // and the receipts accepted, as for any event (T-140).
        "mcpServer/startupStatus/updated" => {}
        _ => crate::model::thread_status_changed(m.agent, p),
    }
    crate::model::settle_status(m.agent, m.pending, || running);
}

fn validate_request_connection(p: &PendingRequest, generation: u64) -> Result<()> {
    if p.stale || p.params["_runtimeGeneration"].as_u64() != Some(generation) {
        bail!("这是旧连接的历史请求，不能对已失效的请求授权");
    }
    if p.params["_responseSent"] == true {
        bail!("回答已提交，正在等待 Harness 确认，请勿重复提交");
    }
    Ok(())
}

fn clear_transport_error(d: &mut AgentDetail, thread: &Value) {
    if thread["status"]["type"] == "systemError" { return; }
    d.agent.error = d.turns.last().filter(|t| t["status"] == "failed")
        .and_then(|t| t["error"]["message"].as_str()).map(str::to_owned);
}

fn synthetic_message(item: &Value) -> bool {
    matches!(item["type"].as_str(), Some("userMessage" | "agentMessage"))
        && item["id"].as_str().and_then(|id| id.strip_prefix("item-"))
            .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|c| c.is_ascii_digit()))
}

fn same_message(left: &Value, right: &Value) -> bool {
    if left["type"] != right["type"] { return false; }
    match left["type"].as_str() {
        Some("userMessage") => left["content"] == right["content"],
        Some("agentMessage") => ["text", "phase", "delivery", "questions"].iter()
            .all(|key| left[key] == right[key]),
        _ => false,
    }
}

/// Codex history can synthesize item-N IDs for messages that had live IDs.
/// Match occurrences in order, never collapse repeated prose indiscriminately.
/// Retain live IDs so existing source/search anchors continue to resolve.
#[cfg(test)]
fn normalize_snapshot_message_ids(existing: &mut Value, incoming: &Value) -> Value {
    normalize_snapshot_message_ids_owned(existing, incoming.clone())
}

fn normalize_snapshot_message_ids_owned(existing: &mut Value, mut incoming: Value) -> Value {
    let (Some(saved), Some(items)) = (existing["items"].as_array_mut(), incoming["items"].as_array_mut()) else {
        return incoming;
    };
    let mut cursor = 0;
    let mut aliases = HashSet::new();
    for item in items.iter_mut() {
        if synthetic_message(item) {
            if let Some(offset) = saved[cursor..].iter().position(|old|
                !synthetic_message(old) && same_message(old, item)) {
                let position = cursor + offset;
                aliases.insert(item["id"].as_str().unwrap().to_owned());
                item["id"] = saved[position]["id"].clone();
                cursor = position + 1;
            }
        } else if let Some(offset) = saved[cursor..].iter().position(|old| old["id"] == item["id"]) {
            cursor += offset + 1;
        }
    }
    saved.retain(|item| !item["id"].as_str().is_some_and(|id| aliases.contains(id)));
    // After a runtime reload Codex may return the live IDs again. Repair
    // aliases already cached by an earlier read, using occurrence counts from
    // this snapshot. Empty/metadata-only snapshots cannot remove any message.
    // Decided first, over borrowed Items, then applied: a Turn's Items are
    // not copied to be read while some are removed.
    let keep: Vec<bool> = {
        let real_items: Vec<&Value> = saved.iter().filter(|item| !synthetic_message(item)).collect();
        let mut retained_aliases: Vec<&Value> = Vec::new();
        saved.iter().map(|item| {
            if !synthetic_message(item) { return true; }
            let confirmed_live = real_items.iter().filter(|real| same_message(real, item)
                && items.iter().any(|incoming| incoming["id"] == real["id"] && same_message(incoming, real))).count();
            let incoming_count = items.iter().filter(|incoming| same_message(incoming, item)).count();
            let kept = retained_aliases.iter().filter(|old| same_message(old, item)).count();
            if confirmed_live > 0 && confirmed_live + kept >= incoming_count { return false; }
            retained_aliases.push(item);
            true
        }).collect()
    };
    let mut keep = keep.into_iter();
    saved.retain(|_| keep.next().unwrap_or(true));
    incoming
}

/// Merges a native snapshot requested before `changes` (see
/// Store::changed_items_since): what changed since is newer than it.
#[cfg(test)]
fn apply_snapshot(d: &mut AgentDetail, thread: &Value, changes: &crate::store::Changes) {
    apply_snapshot_turns(d, thread, thread["turns"].as_array().cloned(), changes);
}

/// A snapshot's Turns, taken out of it for `apply_snapshot_turns`.
fn take_turns(thread: &mut Value) -> Option<Vec<Value>> {
    match thread.get_mut("turns").map(Value::take) {
        Some(Value::Array(turns)) => Some(turns),
        _ => None,
    }
}

/// A Value's `items`, taken out of it.
fn take_items(value: &mut Value) -> Option<Vec<Value>> {
    match value.get_mut("items").map(Value::take) {
        Some(Value::Array(items)) => Some(items),
        _ => None,
    }
}

/// Merges the snapshot `thread`, whose Turns are given by value one at a
/// time: taken out of a reply it owns (`take_turns`), or copied Turn by Turn
/// from one an attach keeps, so a long history is never copied whole.
fn apply_snapshot_turns(d: &mut AgentDetail, thread: &Value, turns: Option<impl IntoIterator<Item = Value>>,
    changes: &crate::store::Changes) {
    let newer_events = changes.newer;
    let mut newer_items = changes.items.clone();
    if newer_events && !changes.complete {
        // Which Items changed is no longer known that far back: any still
        // being produced may be newer than the snapshot.
        newer_items.extend(unfinished_items(d));
    }
    let newer_items = &newer_items;
    if let Some(turns) = turns {
        // Turn by Turn, as `restore` does them: a borrowed snapshot is
        // copied one Turn at a time (T-140).
        let restorer = crate::message_content::Restorer::new(&d.message_receipts);
        for mut incoming in turns {
            restorer.restore(&mut incoming, true);
            if let Some(existing) = d.turns.iter_mut().find(|t| t["id"] == incoming["id"]) {
                let mut incoming = normalize_snapshot_message_ids_owned(existing, incoming);
                let items = take_items(&mut incoming);
                if !newer_events {
                    // A metadata-only or paginated snapshot cannot erase cached items.
                    let cached = take_items(existing).unwrap_or_default();
                    let started_at = existing["startedAt"].clone();
                    let local_started_at = existing["_yuzunoStartedAt"].clone();
                    let times = crate::conversation_time::turn_times(existing);
                    *existing = incoming;
                    crate::conversation_time::restore_turn_times(existing, times);
                    if existing["startedAt"].is_null() && !started_at.is_null() {
                        existing["startedAt"] = started_at;
                    }
                    if !local_started_at.is_null() {
                        existing["_yuzunoStartedAt"] = local_started_at;
                    }
                    existing["items"] = cached.into();
                    if let Some(items) = items {
                        let saved = existing["items"].as_array_mut().unwrap();
                        for item in items {
                            if let Some(old) = saved.iter_mut().find(|i| i["id"] == item["id"]) {
                                crate::conversation_time::replace_item_owned(old, item);
                            } else {
                                saved.push(item);
                            }
                        }
                    }
                } else {
                    // Preserve streamed items that arrived after this snapshot was requested.
                    let newly_finished = existing["status"] == "inProgress"
                        && matches!(incoming["status"].as_str(), Some("completed" | "failed" | "interrupted"));
                    if newly_finished {
                        existing["status"] = incoming["status"].clone();
                        existing["error"] = incoming["error"].clone();
                        crate::conversation_time::merge_native_turn_times(existing, &incoming);
                    }
                    if let (Some(saved), Some(items)) = (existing["items"].as_array_mut(), items) {
                        for item in items {
                            if let Some(old) = saved.iter_mut().find(|i| i["id"] == item["id"]) {
                                let terminal_item = matches!(item["status"].as_str(), Some("completed" | "failed" | "declined" | "interrupted"))
                                    && !matches!(old["status"].as_str(), Some("completed" | "failed" | "declined" | "interrupted"));
                                let changed = item["id"].as_str().is_some_and(|id| newer_items.contains(id));
                                if newly_finished || terminal_item || !changed { crate::conversation_time::replace_item_owned(old, item); }
                            } else {
                                saved.push(item);
                            }
                        }
                    }
                }
            } else {
                d.turns.push(incoming);
            }
        }
    }
    // History does not say whether a contextCompaction Item is still running.
    // Only a start received after this snapshot request is fresh live evidence.
    for turn in &mut d.turns {
        let keep = turn["status"] == "inProgress" && turn["_yuzunoCompactionId"]
            .as_str().is_some_and(|id| newer_events && newer_items.contains(id));
        if !keep {
            turn.as_object_mut().unwrap().remove("_yuzunoCompactionId");
            turn.as_object_mut().unwrap().remove("_yuzunoCompactionStartedAt");
        }
    }
    d.pending.retain(|request| {
        // A terminal native Turn supersedes a historical blocking approval.
        // Non-blocking questions may legitimately outlive their Turn.
        !request.stale || request.params["isBlocking"] == false || !d.turns.iter().any(|turn|
            turn["id"] == request.params["turnId"]
            && matches!(turn["status"].as_str(), Some("completed" | "failed" | "interrupted")))
    });
    let active = d.turns.iter().any(|t| t["status"] == "inProgress")
        || (!newer_events && thread["status"]["type"] == "active")
        || (d.turns.is_empty() && newer_events && d.agent.status == "working");
    d.agent.status = if d.pending.iter().any(request_blocks) {
        "waiting"
    } else if active {
        "working"
    } else if thread["status"]["type"] == "systemError"
        || d.turns.last().is_some_and(|t| t["status"] == "failed") {
        "error"
    } else {
        "idle"
    }
    .into();
    if !newer_events {
        d.agent.error = None;
    }
    if let Some(history) = &mut d.history { history.loaded_count = d.turns.len(); }
    d.refresh_snapshot_evidence();
}

/// Items of a running Turn that may still be streaming: not terminal, and
/// (for messages) not yet completed.
fn unfinished_items(d: &AgentDetail) -> Vec<String> {
    d.turns.iter()
        .filter(|turn| turn["status"] == "inProgress")
        .flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .filter(|item| !matches!(item["status"].as_str(), Some("completed" | "failed" | "declined" | "interrupted"))
            && item["_yuzunoCompletedText"].is_null())
        .filter_map(|item| item["id"].as_str().map(str::to_owned))
        .collect()
}

pub fn validate_response(request: &PendingRequest, response: &Value) -> Result<()> {
    if request.method.ends_with("requestApproval") {
        let decision = response["decision"].as_str().context("缺少审批决定")?;
        if !["accept", "decline", "cancel", "acceptForSession"].contains(&decision) {
            bail!("本版不支持该审批决定");
        }
        if let Some(available) = request.params["availableDecisions"].as_array() {
            if !available.iter().any(|d| d.as_str() == Some(decision)) {
                bail!("Harness 未提供此审批选项");
            }
        }
    } else {
        let answers = response["answers"].as_object().context("缺少问题回答")?;
        for q in request.params["questions"]
            .as_array()
            .context("请求的问题格式无法识别")?
        {
            let id = q["id"].as_str().context("问题缺少 ID")?;
            let values = answers
                .get(id)
                .and_then(|a| a["answers"].as_array())
                .context("请回答所有问题")?;
            if values.is_empty()
                || values
                    .iter()
                    .any(|v| v.as_str().is_none_or(|s| s.is_empty() || s.len() > 20_000))
            {
                bail!("问题回答为空或过长");
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "concurrency_tests.rs"]
mod concurrency_tests;

#[cfg(all(test, unix))]
#[path = "collaboration_admission_tests.rs"]
mod collaboration_admission_tests;

#[cfg(all(test, unix))]
#[path = "native_compact_tests.rs"]
mod native_compact_tests;

#[cfg(all(test, unix))]
#[path = "codex_skills_tests.rs"]
mod codex_skills_tests;

#[cfg(all(test, unix))]
#[path = "codex_review_tests.rs"]
mod codex_review_tests;

#[cfg(all(test, unix))]
#[path = "codex_goal_tests.rs"]
mod codex_goal_tests;

#[cfg(all(test, unix))]
#[path = "codex_mcp_tests.rs"]
mod codex_mcp_tests;

#[cfg(all(test, unix))]
#[path = "codex_plan_tests.rs"]
mod codex_plan_tests;

#[cfg(all(test, unix))]
#[path = "codex_diff_tests.rs"]
mod codex_diff_tests;

#[cfg(all(test, unix))]
#[path = "codex_diff_fixture_tests.rs"]
mod codex_diff_fixture_tests;

#[cfg(all(test, unix))]
#[path = "codex_terminals_tests.rs"]
mod codex_terminals_tests;

#[cfg(all(test, unix))]
#[path = "subagent_requests_tests.rs"]
mod subagent_requests_tests;

#[cfg(all(test, unix))]
#[path = "metadata_event_tests.rs"]
mod metadata_event_tests;

#[cfg(all(test, unix))]
#[path = "reconnect_reads_tests.rs"]
mod reconnect_reads_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_purpose_is_never_injected_into_start_or_resume() {
        let agent: Agent = serde_json::from_value(json!({"id":"a","name":"A","goal":"Do not inject historical purpose","cwd":"/tmp","model":"","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0})).unwrap();
        let start = start_params(&agent);
        assert!(start.get("developerInstructions").is_none());
        let resumed = resume_params("keep-native-thread", &agent);
        assert!(resumed.get("developerInstructions").is_none());
        assert_eq!(resumed["threadId"], "keep-native-thread");
    }

    fn pending(generation: u64) -> PendingRequest {
        PendingRequest {
            id: "p".into(),
            agent_id: "a".into(),
            method: "item/commandExecution/requestApproval".into(),
            params: json!({"_runtimeGeneration":generation,"_rpcId":1}),
            created_at: now(),
            stale: false,
        }
    }

    #[test]
    fn request_id_reuse_in_a_new_connection_cannot_authorize_old_request() {
        let request = pending(1);
        assert!(validate_request_connection(&request, 1).is_ok());
        assert!(validate_request_connection(&request, 2).is_err());
    }

    #[test]
    fn submitted_request_cannot_be_answered_again_before_native_resolution() {
        let mut request = pending(1);
        request.params["_responseSent"] = true.into();
        assert!(validate_request_connection(&request, 1).is_err());
    }

    #[test]
    fn nonblocking_question_is_pending_without_blocking_execution() {
        let mut request = pending(1);
        request.method = "item/tool/requestUserInput".into();
        request.params["isBlocking"] = false.into();
        assert!(!request_blocks(&request));
        request.params["isBlocking"] = true.into();
        assert!(request_blocks(&request));
    }

    #[test]
    fn resume_defaults_are_conservative_and_explicit_settings_are_preserved() {
        let mut agent: Agent = serde_json::from_value(json!({
            "id":"a","name":"A","goal":"test","cwd":"/tmp","model":"test-model","color":"sage",
            "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0
        })).unwrap();
        let p = resume_params("thread", &agent);
        assert_eq!(p["approvalPolicy"], "on-request");
        assert_eq!(p["approvalsReviewer"], "user");
        assert_eq!(p["sandbox"], "workspace-write");
        agent.settings = AgentSettings { context_window: None, auto_compact_token_limit: None, reasoning_effort: Some("high".into()), approval_policy: "never".into(), sandbox: "read-only".into(), permission_preset: None, permission_mode: None };
        let p = resume_params("thread", &agent);
        assert_eq!(p["approvalPolicy"], "never");
        assert_eq!(p["sandbox"], "read-only");
        assert_eq!(p["config"]["model_reasoning_effort"], "high");
        let turn = turn_params(&agent, "thread", "hello", Some("message"));
        assert_eq!(turn["sandboxPolicy"]["type"], "readOnly");
        assert_eq!(turn["effort"], "high");
        assert_eq!(turn["model"], "test-model");
        assert_eq!(turn["approvalPolicy"], "never");
        assert_eq!(turn["clientUserMessageId"], "message");
    }

    fn changes(newer: bool, items: &[&str]) -> crate::store::Changes {
        crate::store::Changes { newer, items: items.iter().map(|item| item.to_string()).collect(), complete: true }
    }

    /// An attach merges the Turns of the reply it keeps one at a time (T-140):
    /// the record comes out as merging them owned does, and the reply is left
    /// as it was, for one large Turn and for many, new and repeated ones.
    #[test]
    fn a_kept_snapshot_merges_as_its_own_turns_do_and_stays_unchanged() {
        let base: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage",
                "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":9,"reviewedSeq":0},
            "turns":[{"id":"t1","status":"completed","items":[{"id":"a1","type":"agentMessage","text":"old"}]},
                {"id":"t2","status":"inProgress","items":[{"id":"live","type":"agentMessage","text":"streamed"}]}],
            "pending":[],"artifacts":[],
            "messageReceipts":[{"input":{"clientMessageId":"c1","text":"hi","textBlocks":[]},"status":"sending"}]
        })).unwrap();
        let large: Vec<Value> = (0..400).map(|i| json!({"id":format!("i{i}"),"type":"agentMessage","text":"x".repeat(512)})).collect();
        let snapshots = [
            json!({"status":{"type":"idle"},"turns":[{"id":"t1","status":"completed","items":large}]}),
            json!({"status":{"type":"active"},"turns":[
                {"id":"t1","status":"completed","items":[{"id":"a1","type":"agentMessage","text":"native"},
                    {"id":"u","type":"userMessage","clientId":"c1","content":[{"type":"text","text":"hi"}]}]},
                {"id":"t2","status":"completed","items":[{"id":"live","type":"agentMessage","text":"older"}]},
                {"id":"t3","status":"inProgress","items":[]},
                {"id":"t3","status":"completed","items":[{"id":"again","type":"agentMessage"}]},
                {"status":"completed","items":[]}]}),
            json!({"status":{"type":"idle"},"turns":[]}),
            json!({"status":{"type":"systemError"}}),
        ];
        for snapshot in &snapshots {
            for changes in [changes(false, &[]), changes(true, &["live"])] {
                let kept = snapshot.clone();
                let mut owned = base.clone();
                apply_snapshot_turns(&mut owned, &kept, kept["turns"].as_array().cloned(), &changes);
                let mut borrowed = base.clone();
                apply_snapshot_turns(&mut borrowed, &kept, kept["turns"].as_array().map(|turns| turns.iter().cloned()), &changes);
                assert_eq!(serde_json::to_value(&borrowed).unwrap(), serde_json::to_value(&owned).unwrap(), "{snapshot}");
                assert_eq!(&kept, snapshot);
            }
        }
    }

    #[test]
    fn snapshot_requested_before_trimmed_evidence_keeps_unfinished_items() {
        let mut d: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage",
                "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":9,"reviewedSeq":0},
            "turns":[{"id":"turn","status":"inProgress","items":[
                {"id":"done","type":"agentMessage","text":"local done","_yuzunoCompletedText":"local done"},
                {"id":"live","type":"agentMessage","text":"live streamed text"}
            ]}],"pending":[],"artifacts":[]
        })).unwrap();
        let snapshot = json!({"status":{"type":"active"},"turns":[{"id":"turn","status":"inProgress","items":[
            {"id":"done","type":"agentMessage","text":"native done"},
            {"id":"live","type":"agentMessage","text":"older"}
        ]}]});
        let incomplete = crate::store::Changes { newer: true, items: HashSet::new(), complete: false };
        apply_snapshot(&mut d, &snapshot, &incomplete);
        assert_eq!(d.turns[0]["items"][1]["text"], "live streamed text");
        assert_eq!(d.turns[0]["items"][0]["text"], "native done");
    }

    #[test]
    fn metadata_only_resume_retains_cached_items() {
        let mut d:AgentDetail=serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage",
                "threadId":"thread","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastMessage":null,"lastSeq":0,"reviewedSeq":0,"error":null},
            "turns":[{"id":"turn","status":"inProgress","items":[{"id":"answer","type":"agentMessage","phase":"final_answer","text":"retained"}]}],
            "pending":[],"artifacts":[]
        })).unwrap();
        apply_snapshot(
            &mut d,
            &json!({"status":{"type":"idle"},"turns":[{"id":"turn","status":"completed","items":[]}]}),
            &changes(false, &[]),
        );
        assert_eq!(d.turns[0]["items"][0]["text"], "retained");
        assert_eq!(d.turns[0]["status"], "completed");
        assert_eq!(d.agent.status, "idle");
    }

    #[test]
    fn completion_snapshot_beats_old_working_state_and_restores_full_evidence() {
        let mut d: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage",
                "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":8,"reviewedSeq":0},
            "turns":[{"id":"turn","status":"inProgress","items":[{"id":"answer","type":"agentMessage","text":"partial"}]}],
            "pending":[],"artifacts":[]
        })).unwrap();
        apply_snapshot(&mut d, &json!({"status":{"type":"idle"},"turns":[{
            "id":"turn","status":"completed","items":[
                {"id":"answer","type":"agentMessage","phase":"final_answer","text":"complete answer"},
                {"id":"file","type":"fileChange","changes":[{"path":"report.md"}]}
            ]}]}), &changes(true, &[]));
        assert_eq!(d.agent.status, "idle");
        assert_eq!(d.turns[0]["items"][0]["text"], "complete answer");
        assert_eq!(d.agent.last_message.as_deref(), Some("complete answer"));
        assert_eq!(d.artifacts[0].path, "report.md");
    }

    #[test]
    fn snapshots_keep_core_message_times_and_never_invent_a_completion_time() {
        let user = json!({"id":"u","type":"userMessage","content":[{"type":"text","text":"go"}]});
        let timed = |mut item: Value, at: i64| { item["_yuzunoTime"] = json!({"at":at,"source":"codex"}); item };
        let mut d: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage",
                "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":8,"reviewedSeq":0},
            "turns":[
                {"id":"done","status":"completed","completedAt":20,"_yuzunoStartedAt":10_000,"_yuzunoCompletedAt":20_100,
                    "items":[timed(user.clone(), 10_100)]},
                {"id":"live","status":"inProgress","items":[timed(json!({"id":"r","type":"agentMessage","text":"par"}), 30_000)]}
            ],
            "pending":[],"artifacts":[]
        })).unwrap();
        // Metadata-only history replaces whole turns: Core records survive.
        apply_snapshot(&mut d, &json!({"status":{"type":"active"},"turns":[
            {"id":"done","status":"completed","completedAt":null,"items":[user.clone()]},
            {"id":"old","status":"completed","completedAt":5,"items":[]}
        ]}), &changes(false, &[]));
        assert_eq!(d.turns[0]["items"][0]["_yuzunoTime"]["at"], 10_100);
        assert_eq!((d.turns[0]["completedAt"].clone(), d.turns[0]["_yuzunoCompletedAt"].clone()), (json!(20), json!(20_100)));
        let old = d.turns.iter().find(|t| t["id"] == "old").unwrap();
        assert!(old["_yuzunoCompletedAt"].is_null(), "discovering an old completion is not seeing it happen");
        // A snapshot racing newer events still keeps the streamed item's time.
        apply_snapshot(&mut d, &json!({"status":{"type":"idle"},"turns":[
            {"id":"live","status":"completed","completedAt":40,"durationMs":9_000,
                "items":[{"id":"r","type":"agentMessage","text":"partial answer"}]}
        ]}), &changes(true, &[]));
        let live = d.turns.iter().find(|t| t["id"] == "live").unwrap();
        assert_eq!(live["items"][0]["_yuzunoTime"]["at"], 30_000);
        assert_eq!((live["completedAt"].clone(), live["durationMs"].clone()), (json!(40), json!(9_000)));
        assert!(live["_yuzunoCompletedAt"].is_null());
    }

    #[test]
    fn history_aliases_preserve_live_anchors_and_separate_repeated_message_occurrences() {
        let mut saved = json!({"id":"turn","status":"completed","items":[
            {"id":"live-user","type":"userMessage","content":[{"type":"text","text":"go"}]},
            {"id":"live-first","type":"agentMessage","phase":"commentary","text":"Checking."},
            {"id":"tool","type":"commandExecution","status":"completed"},
            {"id":"item-1","type":"userMessage","content":[{"type":"text","text":"go"}]},
            {"id":"item-2","type":"agentMessage","phase":"commentary","text":"Checking."},
            {"id":"live-second","type":"agentMessage","phase":"commentary","text":"Checking."}
        ]});
        let history = json!({"id":"turn","status":"completed","items":[
            {"id":"item-1","type":"userMessage","content":[{"type":"text","text":"go"}]},
            {"id":"item-2","type":"agentMessage","phase":"commentary","text":"Checking."},
            {"id":"tool","type":"commandExecution","status":"completed"},
            {"id":"item-4","type":"agentMessage","phase":"commentary","text":"Checking."},
            {"id":"item-5","type":"agentMessage","phase":"commentary","text":"Checking."}
        ]});
        let normalized = normalize_snapshot_message_ids(&mut saved, &history);
        let ids: Vec<_> = normalized["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["live-user", "live-first", "tool", "live-second", "item-5"]);
        assert_eq!(saved["items"].as_array().unwrap().len(), 4);
        let again = normalize_snapshot_message_ids(&mut saved, &history);
        assert_eq!(again, normalized);
    }

    #[test]
    fn returning_live_ids_remove_cached_aliases_without_erasing_repeated_messages() {
        let live = json!({"id":"live","type":"agentMessage","phase":"commentary","text":"Checking."});
        let alias = json!({"id":"item-1","type":"agentMessage","phase":"commentary","text":"Checking."});
        let mut saved = json!({"items":[live.clone(), alias.clone()]});
        normalize_snapshot_message_ids(&mut saved, &json!({"items":[]}));
        assert_eq!(saved["items"].as_array().unwrap().len(), 2);
        normalize_snapshot_message_ids(&mut saved, &json!({"items":[live.clone(), alias.clone()]}));
        assert_eq!(saved["items"].as_array().unwrap().len(), 2, "two authoritative occurrences remain two");
        normalize_snapshot_message_ids(&mut saved, &json!({"items":[live.clone()]}));
        assert_eq!(saved["items"], json!([live]));
    }

    #[test]
    fn active_snapshot_recovers_finished_tool_without_overwriting_newer_streaming_text() {
        let mut d: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage",
                "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":9,"reviewedSeq":0},
            "turns":[{"id":"turn","status":"inProgress","items":[
                {"id":"tool","type":"commandExecution","status":"inProgress","aggregatedOutput":""},
                {"id":"answer","type":"agentMessage","text":"newer streamed text"}
            ]}],"pending":[],"artifacts":[]
        })).unwrap();
        apply_snapshot(&mut d, &json!({"status":{"type":"active"},"turns":[{
            "id":"turn","status":"inProgress","items":[
                {"id":"tool","type":"commandExecution","status":"completed","aggregatedOutput":"offline output","exitCode":0},
                {"id":"answer","type":"agentMessage","text":"older snapshot text"}
            ]}]}), &changes(true, &["answer"]));
        assert_eq!(d.agent.status, "working");
        assert_eq!(d.turns[0]["items"][0]["status"], "completed");
        assert_eq!(d.turns[0]["items"][0]["aggregatedOutput"], "offline output");
        assert_eq!(d.turns[0]["items"][1]["text"], "newer streamed text");
    }

    #[test]
    fn compaction_snapshot_discards_stale_phase_but_preserves_a_new_live_start() {
        let mut d: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"","cwd":"/tmp","model":"","color":"sage",
                "status":"working","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":9,"reviewedSeq":0},
            "turns":[{"id":"t","status":"inProgress","_yuzunoCompactionId":"compact",
                "startedAt":1700000000,"_yuzunoStartedAt":1700000000500_i64,"_yuzunoCompactionStartedAt":1700000060000_i64,
                "items":[{"id":"compact","type":"contextCompaction"}]}],"pending":[],"artifacts":[]
        })).unwrap();
        let snapshot = json!({"status":{"type":"active"},"turns":[{"id":"t","status":"inProgress",
            "items":[{"id":"compact","type":"contextCompaction"}]}]});
        apply_snapshot(&mut d, &snapshot, &changes(true, &["compact"]));
        assert_eq!(d.turns[0]["_yuzunoCompactionId"], "compact");
        assert_eq!(d.turns[0]["_yuzunoCompactionStartedAt"], 1700000060000_i64);
        apply_snapshot(&mut d, &snapshot, &changes(false, &[]));
        assert!(d.turns[0]["_yuzunoCompactionId"].is_null());
        assert!(d.turns[0]["_yuzunoCompactionStartedAt"].is_null());
        assert_eq!(d.turns[0]["startedAt"], 1700000000);
        assert_eq!(d.turns[0]["_yuzunoStartedAt"], 1700000000500_i64);
        assert_eq!(d.turns[0]["items"][0]["type"], "contextCompaction");
    }

    #[test]
    fn unresolved_old_approval_survives_reconnect_until_native_terminal_evidence() {
        let mut d: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage",
                "threadId":"thread","status":"offline","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[{"id":"turn","status":"inProgress","items":[]}],"pending":[],"artifacts":[]
        })).unwrap();
        let mut request = pending(1);
        request.stale = true;
        request.params["turnId"] = "turn".into();
        d.pending.push(request);
        apply_snapshot(&mut d, &json!({"status":{"type":"active"},"turns":[]}), &changes(false, &[]));
        assert_eq!(d.pending.len(), 1);
        assert!(d.pending[0].stale);
        apply_snapshot(&mut d, &json!({"status":{"type":"idle"},"turns":[{"id":"turn","status":"interrupted","items":[]}]}), &changes(false, &[]));
        assert!(d.pending.is_empty());
    }

    /// T-140: a send finds the Agent's harness on its listed view: each
    /// harness's send refuses an empty message as before, and choosing it
    /// reads no whole record.
    #[tokio::test]
    async fn a_send_chooses_its_harness_without_reading_the_whole_record() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = Workspace::new(temp.path().into(), "/tmp".into(), "unused".into()).unwrap();
        for harness in ["codex", "claude", "opencode"] {
            let id = format!("send-harness-{harness}");
            let detail: AgentDetail = serde_json::from_value(json!({
                "agent":{"id":id,"name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage","harness":harness,
                    "status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
                    "pendingCount":0,"lastSeq":0,"reviewedSeq":0},
                "turns":[{"id":"t","status":"completed","items":[{"id":"m","type":"agentMessage","text":"done"}]}],
                "pending":[],"artifacts":[]
            })).unwrap();
            workspace.store.insert(&detail).unwrap();
            let refused = workspace.send(&id, " ".into()).await.unwrap_err();
            assert!(refused.to_string().contains("消息不能为空"), "{harness}: {refused}");
            assert_eq!(crate::store::detail_reads_of(&id), 0, "{harness}: a whole record was read");
        }
        let refused = workspace.send("missing", "hello".into()).await.unwrap_err();
        assert!(refused.to_string().contains("Agent 不存在"), "{refused}");
    }

    #[tokio::test]
    async fn replay_rotates_approval_action_token_without_reopening_read_state() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = Workspace::new(temp.path().into(), "/tmp".into(), "unused".into()).unwrap();
        let mut detail: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage",
                "threadId":"thread","status":"waiting","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]
        })).unwrap();
        let mut old = pending(7);
        old.stale = true; // Generation counters may repeat after Core restarts.
        old.params["threadId"] = "thread".into();
        old.params["turnId"] = "turn".into();
        old.params["itemId"] = "command".into();
        detail.pending.push(old.clone());
        workspace.store.insert(&detail).unwrap();
        // This harmless stdin sink never invokes a harness or model. Using the
        // ordinary transport exercises respond's actual lookup and ownership guard.
        let (tx, _rx) = mpsc::channel(8);
        let rpc = Rpc::spawn("python3", &["-c".into(), "import sys; sys.stdin.read()".into()], tx).await.unwrap();
        workspace.rpcs.lock().unwrap().insert("a".into(), Connection { generation: 7, rpc: rpc.clone(), closing: false, events: None, attachment: Default::default() });
        let incoming = json!({"id":1,"method":"item/commandExecution/requestApproval",
            "params":{"threadId":"thread","turnId":"turn","itemId":"command","command":"printf test"}});
        workspace.dispatch_event("a", 7, incoming.clone()).await;
        let replayed = workspace.store.detail("a").unwrap();
        assert_eq!(replayed.pending.len(), 1);
        assert_ne!(replayed.pending[0].id, old.id);
        assert_eq!(replayed.pending[0].created_at, old.created_at);
        assert_eq!(replayed.agent.unread_count, 0);
        assert!(workspace.respond(&old.id, json!({"decision":"accept"})).await.is_err());
        assert_eq!(workspace.store.detail("a").unwrap().pending[0].params["_responseSent"], false);
        workspace.dispatch_event("a", 7, incoming).await;
        assert_eq!(workspace.store.detail("a").unwrap().pending[0].id, replayed.pending[0].id);
        rpc.close();
    }

    #[tokio::test]
    async fn unknown_creation_without_thread_id_survives_two_retries() {
        let path =
            std::env::temp_dir().join(format!("yuzuno-unknown-retry-{}", uuid::Uuid::new_v4()));
        let workspace =
            Workspace::new(path.clone(), "/tmp".into(), "/must-not-start-codex".into()).unwrap();
        let detail:AgentDetail=serde_json::from_value(json!({
            "agent":{"id":"a","name":"A","goal":"test","cwd":"/tmp","model":"","color":"sage",
                "threadId":null,"status":"uncertain","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastMessage":null,"lastSeq":0,"reviewedSeq":0,"error":"creation timed out"},
            "turns":[],"pending":[],"artifacts":[]
        })).unwrap();
        workspace.store.insert(&detail).unwrap();
        for _ in 0..2 {
            let error = workspace
                .send("a", "retry the original task".into())
                .await
                .unwrap_err();
            assert!(error.to_string().contains("会话创建结果尚未确认"));
            assert_eq!(
                workspace.store.detail("a").unwrap().agent.status,
                "uncertain"
            );
            assert!(workspace.rpcs.lock().unwrap().is_empty());
        }
        drop(workspace);
        std::fs::remove_dir_all(path).unwrap();
    }

    /// Opt-in native smoke, isolated from the ordinary offline test suite.
    /// The launcher supplies a fresh file-auth CODEX_HOME and no provider keys.
    #[test]
    #[ignore = "requires an installed Codex CLI and a fresh unauthenticated temporary CODEX_HOME"]
    fn real_empty_session_reopens_without_a_model_turn() -> Result<()> {
        let profile = PathBuf::from(std::env::var_os("CODEX_HOME").context("CODEX_HOME required")?)
            .canonicalize()?;
        anyhow::ensure!(
            profile.starts_with(std::env::temp_dir().canonicalize()?),
            "Only a temporary profile is allowed"
        );
        anyhow::ensure!(
            !profile.join("auth.json").exists(),
            "Existing authentication is forbidden"
        );
        anyhow::ensure!(
            std::fs::read_to_string(profile.join("config.toml"))?
                .contains("cli_auth_credentials_store = \"file\""),
            "File authentication required"
        );
        for variable in ["OPENAI_API_KEY", "CODEX_ACCESS_TOKEN", "CODEX_API_KEY"] {
            anyhow::ensure!(
                std::env::var_os(variable).is_none(),
                "Inherited provider credential is forbidden"
            );
        }
        let root = tempfile::Builder::new()
            .prefix("yuzuno-empty-workspace-")
            .tempdir()?;
        let mut identity = String::new();
        let mut previous_thread = String::new();
        let mut incarnations = Vec::new();
        for restart in 0..3 {
            let runtime = tokio::runtime::Runtime::new()?;
            let detail = runtime.block_on(async {
                let workspace = Workspace::new(
                    root.path().join("workspace"),
                    root.path().to_string_lossy().into(),
                    "codex".into(),
                )?;
                if restart == 0 {
                    let created = workspace
                        .create(
                            "Empty-session smoke".into(),
                            "Preserve this workspace identity".into(),
                            root.path().to_string_lossy().into(),
                            String::new(),
                        )
                        .await?;
                    identity = created.id;
                }
                // create() also uses this per-agent gate, so waiting for it
                // cannot race the initial native attachment.
                let gate = workspace.gate(&identity).await;
                let _held = gate.lock().await;
                workspace.ensure(&identity).await?;
                workspace.store.detail(&identity)
            })?;
            // Terminate only this test's owned app-server before reopening.
            drop(runtime);
            anyhow::ensure!(
                detail.agent.id == identity && detail.agent.status == "idle",
                "Workspace identity or ready state changed"
            );
            anyhow::ensure!(
                detail.turns.is_empty(),
                "A model Turn was unexpectedly started"
            );
            let thread = detail.agent.thread_id.context("Missing native thread")?;
            anyhow::ensure!(
                thread != previous_thread,
                "Expected a new native empty thread after process restart"
            );
            previous_thread = thread.clone();
            incarnations.push(json!({"restart":restart,"agentId":identity,"threadId":thread,"status":detail.agent.status,"turns":0}));
        }
        let report = json!({"kind":"real-empty-session-core-recovery","timestamp":now(),
            "passed":true,"authenticated":false,"modelTurnsStarted":0,"coreIncarnations":incarnations});
        if let Some(path) = std::env::var_os("YUZUNO_EMPTY_REPORT") {
            std::fs::write(path, serde_json::to_string_pretty(&report)? + "\n")?;
        }
        println!("{}", serde_json::to_string_pretty(&report)?);
        Ok(())
    }
}
