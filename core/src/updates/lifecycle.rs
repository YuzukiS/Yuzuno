//! Workspace-specific update lifecycle. Native queues are drained explicitly;
//! no Agent is closed, no prompt is replayed, and offline sessions stay offline.
use super::{
    controller::{Blocker, Runtime},
    state::SessionRef,
};
use crate::{model::{Agent, AgentDetail}, store::Activity, workspace::Workspace};
use anyhow::{ensure, Context, Result};
use futures_util::{future::BoxFuture, FutureExt};
use serde_json::{json, Value};
use std::sync::Arc;

pub struct WorkspaceRuntime(pub Arc<Workspace>);

fn blocked(detail: &AgentDetail) -> Option<String> {
    blocked_activity(&detail.agent, Activity::of(detail))
}

fn blocked_activity(agent: &Agent, activity: Activity) -> Option<String> {
    if agent.closed_at.is_some() {
        return None;
    }
    if activity.pending {
        return Some("Waiting for an approval or answer".into());
    }
    if activity.sending {
        return Some("A message is still being sent".into());
    }
    if agent.connection_state == "connecting" {
        return Some("Native session is connecting".into());
    }
    if agent.status == "uncertain" || activity.uncertain {
        return Some("A native result is uncertain; reconcile this session first".into());
    }
    if matches!(agent.status.as_str(), "working" | "waiting") || activity.running {
        return Some("Turn is still running".into());
    }
    None
}
fn native_id(detail: &AgentDetail) -> Option<&str> {
    if detail.agent.harness == "claude" {
        detail.agent.claude_session_id.as_deref()
    } else {
        detail.agent.thread_id.as_deref()
    }
}

fn background_blocker(shells: Option<Value>) -> Option<String> {
    let shells = shells?;
    let count = shells["count"].as_u64()?;
    (shells["state"] == "known" && count > 0).then(|| format!(
        "{count} background shell(s) still running; finish or stop them before updating"
    ))
}

impl Runtime for WorkspaceRuntime {
    fn configure_update_notices(&self, layout: &super::state::Layout) {
        let _ = self.0.update_notice_layout.set(layout.clone());
    }
    fn request_update_pause<'a>(&'a self, op: &'a super::state::Operation) -> BoxFuture<'a, Result<()>> {
        async move {
            let op = op.clone();
            self.0.stored(move |store| store.queue_update_pause(&op)).await?;
            self.0.collaboration_wakeup.notify_one();
            Ok(())
        }.boxed()
    }
    fn update_pause_status(&self, op: &super::state::Operation) -> Result<Value> {
        self.0.update_pause_status(op)
    }
    fn workspace_id(&self) -> Result<String> {
        self.0.store.workspace_id()
    }
    fn blockers(&self) -> Result<Vec<Blocker>> {
        let mut result = vec![];
        for agent in self.0.store.agents()? {
            if agent.closed_at.is_some() { continue; }
            let (agent, activity) = self.0.store.update_readiness(&agent.id)?;
            if agent.closed_at.is_some() { continue; }
            if let Some(reason) = blocked_activity(&agent, activity).or_else(||
                background_blocker(crate::background_shells::shells(&self.0, &agent.id))) {
                result.push(Blocker {
                    agent_id: Some(agent.id),
                    name: agent.name,
                    reason,
                });
            }
        }
        Ok(result)
    }
    fn sessions(&self) -> Result<Vec<SessionRef>> {
        let mut sessions = vec![];
        for agent in self.0.store.agents()? {
            if agent.closed_at.is_some() || agent.connection_state != "connected" {
                continue;
            }
            let detail = self.0.store.detail(&agent.id)?;
            if let Some(id) = native_id(&detail) {
                sessions.push(SessionRef {
                    agent_id: agent.id,
                    harness: agent.harness,
                    native_id: id.into(),
                });
            }
        }
        Ok(sessions)
    }
    fn health(&self) -> Result<Value> {
        let db = self.0.store.db.read()?;
        let schema: u32 = db.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        ensure!(
            schema == super::package::STORAGE,
            "Workspace schema differs from this release"
        );
        // Real critical-table reads, not a static 200 or a probe against some
        // other service that happens to own the expected TCP port.
        let workspace: String = db.query_row(
            "SELECT value FROM workspace_meta WHERE key='workspaceId'",
            [],
            |r| r.get(0),
        )?;
        ensure!(!workspace.is_empty(), "Workspace identity is missing");
        for table in ["agents", "journal"] {
            let _: i64 = db.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM {table} LIMIT 1)"),
                [],
                |r| r.get(0),
            )?;
        }
        // Public connectivity and frequent private Inspect probes must remain
        // independent of history size and Damaged Agent records. A fresh,
        // bounded verifier process proves records at each update boundary.
        Ok(
            json!({"storageReady":true,"apiReady":true,"schema":schema}),
        )
    }
    fn flush(&self) -> BoxFuture<'_, Result<()>> {
        self.0.flush_for_update().boxed()
    }
    fn detach(&self) -> BoxFuture<'_, Result<()>> {
        self.0.detach_for_update().boxed()
    }
    fn restore<'a>(&'a self, sessions: &'a [SessionRef]) -> BoxFuture<'a, Result<usize>> {
        async move {
            let mut restored = 0;
            let mut errors = vec![];
            for session in sessions {
                let result = async {
                let before = self.0.detail(&session.agent_id).await?;
                ensure!(before.agent.closed_at.is_none() && before.agent.harness == session.harness && native_id(&before) == Some(&session.native_id), "Stored native session identity changed for {}", before.agent.name);
                let connected = if before.agent.harness == "claude" {
                    self.0.claudes.lock().unwrap().contains_key(&session.agent_id)
                } else {
                    self.0.codex_connection(&session.agent_id).is_some()
                };
                // During an intentional detach the stored connected projection
                // can survive until Core exits. Aborting in the same Core must
                // inspect the live transport too before deciding to skip resume.
                if !connected || before.agent.connection_state != "connected" { self.0.reconnect_for_update(&session.agent_id).await?; }
                let after = self.0.detail(&session.agent_id).await?;
                ensure!(after.agent.connection_state == "connected" && native_id(&after) == Some(&session.native_id), "Native session did not restore for {}", after.agent.name);
                self.0.require_collaboration(&session.agent_id).await?;
                ensure!(blocked(&after).is_none(), "Restored session {} has active or uncertain native work; keep this Core running", after.agent.name);
                Ok::<_, anyhow::Error>(())
                }.await;
                match result {
                    Ok(()) => restored += 1,
                    Err(error) => errors.push(format!("{}: {error:#}", session.agent_id)),
                }
            }
            self.0.flush_for_update().await?;
            ensure!(errors.is_empty(), "Some sessions need reconnection: {}", errors.join("; "));
            Ok(restored)
        }.boxed()
    }
}

impl Workspace {
    async fn reconnect_for_update(self: &Arc<Self>, id: &str) -> Result<AgentDetail> {
        ensure!(
            self.admission.snapshot().operation_id.is_some(),
            "Update restore requires closed new-work admission"
        );
        let permit = self.admission.enter_event();
        self.reconnect_accepted(id, &permit).await
    }

    /// Includes all messages enqueued before each marker. After detach, the
    /// native producer's stopped receipt proves no more messages can follow.
    pub(crate) async fn flush_for_update(&self) -> Result<()> {
        let codex = self
            .rpcs
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let claude = self
            .claudes
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        for connection in codex {
            if let Some(events) = connection.events {
                events.drain().await?;
            }
        }
        for connection in claude {
            if let Some(events) = connection.events {
                events.drain().await?;
            }
        }
        self.flush_event_writes().await?;
        self.stored(|store| {
            let db = store.db.write()?;
            let (busy, _, _): (i64, i64, i64) =
                db.query_row("PRAGMA wal_checkpoint(FULL)", [], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?))
                })?;
            ensure!(busy == 0, "Workspace WAL is still busy");
            Ok(())
        })
        .await
    }

    pub(crate) async fn detach_for_update(self: &Arc<Self>) -> Result<()> {
        ensure!(
            self.admission.snapshot().sealed,
            "Native detach requires sealed admission"
        );
        ensure!(
            {
                let runtime = WorkspaceRuntime(self.clone());
                crate::db::blocking(move || runtime.blockers())
                    .await?
                    .is_empty()
            },
            "Active native work prevents update detach"
        );
        let codex = self
            .rpcs
            .lock()
            .unwrap()
            .iter()
            .map(|(id, c)| (id.clone(), c.clone()))
            .collect::<Vec<_>>();
        for (id, connection) in codex {
            let gate = self.gate(&id).await;
            let _held = gate.lock().await;
            if id != "_catalog" {
                let detail = self.detail(&id).await?;
                ensure!(
                    blocked(&detail).is_none(),
                    "{} still has work",
                    detail.agent.name
                );
                let native = connection
                    .rpc
                    .request(
                        "thread/read",
                        json!({"threadId":detail.agent.thread_id,"includeTurns":false}),
                    )
                    .await?;
                ensure!(
                    native["thread"]["status"]["type"] == "idle",
                    "{} native runtime has not confirmed idle",
                    detail.agent.name
                );
                connection
                    .events
                    .as_ref()
                    .context("Native event barrier is missing")?
                    .drain()
                    .await?;
                ensure!(
                    blocked(&self.detail(&id).await?).is_none(),
                    "Native work arrived before detach"
                );
            }
            {
                let _owned = self.owner(&id).await;
                if let Some(current) = self
                    .rpcs
                    .lock()
                    .unwrap()
                    .get_mut(&id)
                    .filter(|c| c.generation == connection.generation)
                {
                    current.closing = true;
                }
            }
            // Remote::stop_runtime is deliberately not called: detach closes
            // only this Core's transport, preserving the remote native session.
            connection.rpc.close_and_wait().await?;
            if let Some(events) = &connection.events {
                events.drain().await?;
            }
            let _owned = self.owner(&id).await;
            let mut connections = self.rpcs.lock().unwrap();
            if connections
                .get(&id)
                .is_some_and(|c| c.generation == connection.generation)
            {
                connections.remove(&id);
            }
        }
        let claude = self
            .claudes
            .lock()
            .unwrap()
            .iter()
            .map(|(id, c)| (id.clone(), c.clone()))
            .collect::<Vec<_>>();
        for (id, connection) in claude {
            let gate = self.gate(&id).await;
            let _held = gate.lock().await;
            let status = connection.bridge.request(json!({"op":"status"})).await?;
            ensure!(
                status["ready"] == true
                    && status["turnId"].is_null()
                    && status["pendingCount"] == 0
                    && status["configuring"] == false
                    && status["interrupting"] == false,
                "Claude native runtime has not confirmed idle"
            );
            let events = connection
                .events
                .as_ref()
                .context("Native event barrier is missing")?;
            events.drain().await?;
            ensure!(
                blocked(&self.detail(&id).await?).is_none(),
                "Claude work arrived before detach"
            );
            events.mark_closing();
            connection.bridge.close_and_wait().await?;
            events.drain().await?;
            let _owned = self.owner(&id).await;
            let mut connections = self.claudes.lock().unwrap();
            if connections
                .get(&id)
                .is_some_and(|c| c.generation == connection.generation)
            {
                connections.remove(&id);
            }
        }
        // All native producers have stopped and each consumer acknowledged its
        // final marker. Only now is a cache flush/checkpoint a durable barrier.
        self.flush_for_update().await
    }

    /// Consumed in queue order instead of treating the updater's intentional
    /// idle detach as an unexpected Claude failure. Other events stay unchanged.
    pub(crate) async fn update_claude_detached(&self, id: &str, generation: u64) {
        let owned = self.owner(id).await;
        if !self
            .claudes
            .lock()
            .unwrap()
            .get(id)
            .is_some_and(|c| c.generation == generation)
        {
            return;
        }
        let agent = id.to_owned();
        let _ = self
            .stored_owned(owned, move |store| {
                store.update(&agent, "runtime/updateDetached", &json!({}), |d| {
                    d.agent.connection_state = "disconnected".into();
                    d.agent.status = "offline".into();
                    if let Some(usage) = &mut d.context_usage {
                        usage.stale = true;
                    }
                })
            })
            .await;
        self.changed(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::MessageInput;

    #[test]
    fn update_probe_keeps_status_priority_and_closed_agent_guards() {
        let mut detail = super::super::storage::tests::record();
        detail.agent.status = "waiting".into();
        let activity = Activity { pending: true, sending: true, uncertain: true, running: true };
        assert_eq!(blocked_activity(&detail.agent, activity).as_deref(), Some("Waiting for an approval or answer"));
        assert_eq!(blocked_activity(&detail.agent, Activity { pending: false, ..activity }).as_deref(), Some("A message is still being sent"));
        detail.agent.connection_state = "connecting".into();
        assert_eq!(blocked_activity(&detail.agent, Activity { pending: false, sending: false, ..activity }).as_deref(), Some("Native session is connecting"));
        detail.agent.connection_state = "connected".into();
        assert!(blocked_activity(&detail.agent, Activity { uncertain: true, ..Activity::default() }).unwrap().contains("uncertain"));
        for status in ["working", "waiting"] {
            detail.agent.status = status.into();
            assert_eq!(blocked_activity(&detail.agent, Activity::default()).as_deref(), Some("Turn is still running"));
        }
        detail.agent.status = "uncertain".into();
        assert!(blocked_activity(&detail.agent, Activity::default()).unwrap().contains("uncertain"));
        detail.agent.status = "idle".into();
        assert!(blocked_activity(&detail.agent, Activity::default()).is_none());
        assert_eq!(blocked_activity(&detail.agent, Activity { running: true, ..Activity::default() }).as_deref(), Some("Turn is still running"));
        detail.agent.closed_at = Some("closed".into());
        assert!(blocked_activity(&detail.agent, activity).is_none());
    }

    #[test]
    #[ignore = "isolated large-history measurement; run explicitly"]
    fn update_probe_large_history_measurement() {
        use std::time::Instant;
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::new(root.path().into(), "/fixture".into(), "must-not-run".into()).unwrap();
        for n in 0..8 {
            let mut detail = super::super::storage::tests::record();
            detail.agent.id = format!("large-{n}");
            detail.turns = (0..64).map(|t| json!({"id":format!("turn-{t}"),"status":"completed","items":[
                {"id":format!("item-{t}"),"type":"commandExecution","status":"completed","aggregatedOutput":"x".repeat(65536)}
            ]})).collect();
            detail.turns.push(json!({"id":"latest","status":"completed","items":[]}));
            ws.store.insert(&detail).unwrap();
        }
        let runtime = WorkspaceRuntime(ws);
        assert!(runtime.blockers().unwrap().is_empty());
        let start = Instant::now();
        for _ in 0..20 { assert!(runtime.blockers().unwrap().is_empty()); }
        println!("update_probe_measurement: agents=8 turns_each=65 payload_bytes=33554432 probes=20 elapsed_ms={:.3}", start.elapsed().as_secs_f64() * 1000.0);
    }

    #[test]
    fn known_background_shells_block_updates_without_turn_status_or_unknown_deadlock() {
        assert!(background_blocker(Some(json!({"state":"known","count":2}))).unwrap().contains("2 background shell"));
        assert!(background_blocker(Some(json!({"state":"known","count":0}))).is_none());
        assert!(background_blocker(Some(json!({"state":"unknown","lastCount":2}))).is_none());
        assert!(background_blocker(None).is_none());
        let mut detail = super::super::storage::tests::record();
        detail.turns.insert(0, json!({"id":"native-continuation","status":"inProgress","items":[]}));
        assert!(blocked(&detail).unwrap().contains("Turn"), "all turns, not just the latest user turn");
    }

    #[tokio::test]
    async fn stored_native_identity_is_not_success_without_a_live_ready_connection() {
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::new(root.path().into(), "/fixture".into(), "must-not-run".into()).unwrap();
        let record: AgentDetail = serde_json::from_value(json!({
            "agent":{"id":"a","name":"a","cwd":"/fixture","model":"m","color":"sage",
                "threadId":"thread","status":"idle","connectionState":"connected","createdAt":"","updatedAt":"",
                "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]
        })).unwrap();
        ws.store.insert(&record).unwrap();
        ws.collaboration_url.set("http://127.0.0.1:4473".into()).unwrap();
        ws.admission.begin_drain("restore").unwrap();
        let sessions = [SessionRef { agent_id: "a".into(), harness: record.agent.harness, native_id: "thread".into() }];
        let error = WorkspaceRuntime(ws.clone()).restore(&sessions).await.unwrap_err();
        assert!(error.to_string().contains("Some sessions need reconnection"));
        assert!(ws.admission.snapshot().operation_id.is_some());
        assert_eq!(ws.detail("a").await.unwrap().agent.thread_id.as_deref(), Some("thread"));
    }

    #[tokio::test]
    async fn cancelled_store_waiter_keeps_admission_until_blocking_write_finishes() {
        let root = tempfile::tempdir().unwrap();
        let ws =
            Workspace::new(root.path().into(), "/fixture".into(), "must-not-run".into()).unwrap();
        let (entered_tx, entered_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let worker = ws.clone();
        let waiter = tokio::spawn(async move {
            worker.stored(move |store| {
                entered_tx.send(()).unwrap();
                release_rx.recv().unwrap();
                store.db.write()?.execute_batch("CREATE TABLE update_sentinel(value TEXT); INSERT INTO update_sentinel VALUES('committed');")?;
                Ok(())
            }).await
        });
        entered_rx.await.unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        ws.admission.begin_drain("update").unwrap();
        assert!(!ws.admission.try_seal("update").unwrap());
        release_tx.send(()).unwrap();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            ws.admission.wait_quiescent(),
        )
        .await
        .unwrap();
        assert!(ws.admission.try_seal("update").unwrap());
        assert_eq!(
            ws.store
                .db
                .read()
                .unwrap()
                .query_row("SELECT value FROM update_sentinel", [], |r| r
                    .get::<_, String>(0))
                .unwrap(),
            "committed"
        );
    }

    #[tokio::test]
    async fn public_health_remains_connectable_with_large_or_damaged_agent_payloads() {
        use axum::{body::Body, http::{Request, StatusCode}};
        use tower::ServiceExt;
        let root = tempfile::tempdir().unwrap();
        let ws = Workspace::new(root.path().into(), "/fixture".into(), "must-not-run".into()).unwrap();
        for n in 0..8 {
            let mut detail = super::super::storage::tests::record();
            detail.agent.id = format!("large-{n}");
            detail.turns[0]["items"][0]["aggregatedOutput"] = json!("大 payload\n".repeat(300_000));
            ws.store.insert(&detail).unwrap();
        }
        let workspace_id = ws.store.workspace_id().unwrap();
        assert_eq!(super::super::storage::verify_at(root.path(), &workspace_id).unwrap()["recordsChecked"], 8);
        ws.store.db.write().unwrap().execute("UPDATE agent_payloads SET data='not json' WHERE agent_id='large-0'", []).unwrap();
        assert!(super::super::storage::verify_at(root.path(), &workspace_id).is_err());
        let controller = super::super::controller::Controller::new(None, None,
            super::super::state::Launch {port:4399,data_dir:root.path().into(),cwd:root.path().into(),codex:"never".into()},
            Arc::new(WorkspaceRuntime(ws.clone())), ws.admission.clone()).unwrap();
        let app = crate::server::router_with_updates(ws, root.path().join("ui"), 4399, Some(controller));
        let start = std::time::Instant::now();
        for _ in 0..20 {
            let response = app.clone().oneshot(Request::builder().uri("/api/health").header("host", "127.0.0.1:4399").body(Body::empty()).unwrap()).await.unwrap();
            assert_eq!(response.status(), StatusCode::OK);
        }
        assert!(start.elapsed() < std::time::Duration::from_secs(2), "light health must not parse the history");
    }

    #[test]
    fn health_verifies_workspace_storage_instead_of_returning_static_success() {
        let root = tempfile::tempdir().unwrap();
        let workspace = Workspace::new(
            root.path().into(),
            root.path().to_string_lossy().into(),
            "must-not-run".into(),
        )
        .unwrap();
        let runtime = WorkspaceRuntime(workspace.clone());
        assert_eq!(runtime.health().unwrap()["storageReady"], true);
        workspace
            .store
            .db
            .write()
            .unwrap()
            .execute_batch("DROP TABLE journal")
            .unwrap();
        assert!(runtime.health().is_err());
    }
    #[tokio::test]
    async fn native_work_entries_are_fenced_but_completion_responses_are_allowed_until_sealed() {
        let root = tempfile::tempdir().unwrap();
        let workspace = Workspace::new(
            root.path().into(),
            root.path().to_string_lossy().into(),
            "must-not-run".into(),
        )
        .unwrap();
        workspace.admission.begin_drain("update").unwrap();
        let fresh: MessageInput =
            serde_json::from_value(json!({"clientMessageId":"fresh","text":"keep this draft"}))
                .unwrap();
        let error = workspace.send_message("missing", fresh).await.unwrap_err();
        assert!(error.to_string().starts_with("workspace_updating:"));
        assert!(workspace
            .create(
                "new".into(),
                String::new(),
                root.path().to_string_lossy().into(),
                String::new()
            )
            .await
            .unwrap_err()
            .to_string()
            .starts_with("workspace_updating:"));
        assert!(!workspace
            .respond("missing", json!({}))
            .await
            .unwrap_err()
            .to_string()
            .starts_with("workspace_updating:"));
        workspace
            .deliver_peer_batch(&json!({"agentId":"missing"}))
            .await
            .unwrap();
        assert!(workspace.store.agents().unwrap().is_empty());
        assert!(workspace.admission.try_seal("update").unwrap());
        assert!(workspace
            .respond("missing", json!({}))
            .await
            .unwrap_err()
            .to_string()
            .starts_with("workspace_updating:"));
        workspace.admission.reopen("update").unwrap();
        assert!(!workspace
            .reconnect("missing")
            .await
            .unwrap_err()
            .to_string()
            .starts_with("workspace_updating:"));
    }
}
