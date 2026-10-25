//! Read-only observations of MCP servers on an existing Claude connection.
//! Neither this endpoint nor a cache miss starts a native runtime or prompt.
use crate::{claude::Connection, model::Agent, server::ApiError, workspace::Workspace};
use anyhow::Result;
use axum::{
    extract::{Path, Query, State as ApiState},
    routing::get,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

const FRESH_FOR: Duration = Duration::from_secs(60);

#[derive(Default)]
pub(crate) struct State(Mutex<HashMap<String, Arc<Entry>>>);

#[derive(Clone, Debug, PartialEq, Eq)]
struct Scope {
    cwd: String,
    session: Option<String>,
    machine: Option<String>,
    generation: Option<u64>,
}

impl Scope {
    fn same_environment(&self, other: &Self) -> bool {
        self.cwd == other.cwd && self.session == other.session && self.machine == other.machine
    }
}

struct Context {
    scope: Scope,
    connection: Option<Connection>,
    unavailable: Option<&'static str>,
}

struct Entry {
    scope: Scope,
    refresh: tokio::sync::Mutex<()>,
    cache: Mutex<Cache>,
}

#[derive(Default)]
struct Cache {
    attempted: Option<Instant>,
    checked_at: Option<String>,
    failure: Option<&'static str>,
    observation: Option<(Instant, Observation)>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Status {
    Connected,
    Failed,
    NeedsAuth,
    Pending,
    Disabled,
    #[serde(other)]
    Unknown,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum Reason {
    Authentication,
    Timeout,
    Executable,
    Connection,
    Configuration,
    #[serde(other)]
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Server {
    name: String,
    status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<Reason>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    observed_at: String,
    servers: Vec<Server>,
    total: usize,
    truncated: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Wire {
    state: String,
    session_id: Option<String>,
    #[serde(default)]
    servers: Vec<Server>,
    #[serde(default)]
    total: usize,
    #[serde(default)]
    truncated: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    state: &'static str,
    reason: &'static str,
    generation: Option<u64>,
    session_id: Option<String>,
    checked_at: Option<String>,
    observation: Option<Observation>,
    stale: bool,
    fresh_for_seconds: u64,
}

impl State {
    fn entry(&self, id: &str, scope: &Scope) -> Arc<Entry> {
        let mut entries = self.0.lock().unwrap();
        if let Some(entry) = entries.get(id) {
            // A disconnected connection may keep its old observation only as
            // stale. A replacement generation/environment never inherits it.
            if entry.scope.same_environment(scope)
                && (scope.generation.is_none() || entry.scope.generation == scope.generation)
            {
                return entry.clone();
            }
        }
        let entry = Arc::new(Entry {
            scope: scope.clone(),
            refresh: Default::default(),
            cache: Default::default(),
        });
        entries.insert(id.to_owned(), entry.clone());
        entry
    }
}

impl Entry {
    fn view(&self, context: &Context, now: Instant) -> View {
        let cache = self.cache.lock().unwrap();
        let expired = cache
            .observation
            .as_ref()
            .is_some_and(|(at, _)| now.saturating_duration_since(*at) >= FRESH_FOR);
        let (state, reason) = if let Some(reason) = context.unavailable {
            ("unavailable", reason)
        } else if let Some(reason) = cache.failure {
            (
                if reason == "unsupported" {
                    "unsupported"
                } else {
                    "failed"
                },
                reason,
            )
        } else if expired {
            ("stale", "expired")
        } else if cache.observation.is_some() {
            ("ready", "observed")
        } else {
            ("unknown", "not_observed")
        };
        View {
            state,
            reason,
            generation: context.scope.generation,
            session_id: context.scope.session.clone(),
            checked_at: cache.checked_at.clone(),
            observation: cache.observation.as_ref().map(|(_, o)| o.clone()),
            stale: state != "ready",
            fresh_for_seconds: FRESH_FOR.as_secs(),
        }
    }
}

impl Workspace {
    async fn mcp_context(&self, id: &str) -> Result<Context> {
        let _owner = self.owner(id).await;
        self.mcp_context_owned(id).await
    }

    async fn mcp_context_owned(&self, id: &str) -> Result<Context> {
        let key = id.to_owned();
        let agent: Agent = self.stored(move |store| store.agent(&key)).await?;
        anyhow::ensure!(
            agent.harness == "claude",
            "MCP status is only available for Claude Agents"
        );
        let connection = self.claudes.lock().unwrap().get(id).cloned();
        let unavailable = if agent.closed_at.is_some() {
            Some("closed")
        } else if agent.remote.is_some() {
            Some("remote_unavailable")
        } else if agent.connection_state == "connecting" {
            Some("initializing")
        } else if agent.connection_state != "connected" || connection.is_none() {
            Some("not_connected")
        } else {
            None
        };
        Ok(Context {
            scope: Scope {
                cwd: agent.cwd,
                session: agent.claude_session_id,
                machine: agent.remote.map(|remote| remote.machine.id),
                generation: connection.as_ref().map(|c| c.generation),
            },
            connection,
            unavailable,
        })
    }

    /// What the last read found, without asking Claude Code even when it
    /// has never been asked: an overview of several Agents reads this, and
    /// only an explicit refresh asks (T-191).
    pub async fn claude_mcp_status_cached(&self, id: &str) -> Result<View> {
        let _permit = self.admission.enter_work()?;
        let context = self.mcp_context(id).await?;
        Ok(self
            .claude_mcp
            .entry(id, &context.scope)
            .view(&context, Instant::now()))
    }

    pub async fn claude_mcp_status(&self, id: &str, refresh: bool) -> Result<View> {
        let _permit = self.admission.enter_work()?;
        let started = Instant::now();
        let context = self.mcp_context(id).await?;
        let entry = self.claude_mcp.entry(id, &context.scope);
        if context.unavailable.is_some() {
            return Ok(entry.view(&context, Instant::now()));
        }
        let _refresh = entry.refresh.lock().await;
        let context = self.mcp_context(id).await?;
        if context.unavailable.is_some() || context.scope != entry.scope {
            return Ok(self
                .claude_mcp
                .entry(id, &context.scope)
                .view(&context, Instant::now()));
        }
        {
            let cache = entry.cache.lock().unwrap();
            // A GET observes the existing result, even a failure or an expired
            // observation. Only explicit refresh asks again. Concurrent callers
            // share the attempt that completed after they arrived.
            if cache.attempted.is_some_and(|at| !refresh || at >= started) {
                drop(cache);
                return Ok(entry.view(&context, Instant::now()));
            }
        }
        let connection = context.connection.as_ref().unwrap();
        let result = connection.bridge.request(json!({"op":"mcp_status"})).await;
        // Never keep raw transport errors: they can contain native diagnostics.
        let wire = result
            .ok()
            .and_then(|value| serde_json::from_value::<Wire>(value).ok());
        let _owner = self.owner(id).await;
        let current = self.mcp_context_owned(id).await?;
        if current.unavailable.is_some() || current.scope != context.scope {
            return Ok(self
                .claude_mcp
                .entry(id, &current.scope)
                .view(&current, Instant::now()));
        }
        {
            let mut cache = entry.cache.lock().unwrap();
            cache.attempted = Some(Instant::now());
            cache.checked_at = Some(crate::model::now());
            cache.failure = Some("read_failed");
            if let Some(mut wire) = wire {
                // Core names a session from its first turn's events; Claude
                // Code names a new one sooner, on a SessionStart hook before
                // any turn. Until Core has named one, the connection's own
                // session is the Agent's: the generation fence above and the
                // bridge's own check across the read (`changed`) still refuse
                // a reply from any other. Once named, only that session's.
                let own_session =
                    current.scope.session.is_none() || wire.session_id == current.scope.session;
                if wire.state == "ready" && own_session {
                    // Re-apply a small closed schema at the Core boundary.
                    wire.truncated |= wire.servers.len() > 256;
                    wire.servers.truncate(256);
                    for (index, server) in wire.servers.iter_mut().enumerate() {
                        if server.name.is_empty()
                            || server.name.len() > 640
                            || server.name.chars().any(char::is_control)
                        {
                            server.name = format!("MCP service {}", index + 1);
                        }
                    }
                    cache.observation = Some((
                        Instant::now(),
                        Observation {
                            observed_at: crate::model::now(),
                            total: wire.total.max(wire.servers.len()),
                            servers: wire.servers,
                            truncated: wire.truncated,
                        },
                    ));
                    cache.failure = None;
                } else if wire.state == "unsupported" {
                    cache.failure = Some("unsupported");
                } else if wire.state == "unavailable" {
                    cache.failure = Some("initializing");
                } else if wire.state == "changed" || wire.state == "ready" && !own_session {
                    cache.observation = None;
                    cache.failure = Some("changed");
                }
            }
        }
        Ok(entry.view(&current, Instant::now()))
    }
}

#[derive(Deserialize)]
struct ReadQuery {
    /// Only what the last read found; never asks Claude Code.
    #[serde(default)]
    cached: bool,
}

async fn read(
    ApiState(ws): ApiState<Arc<Workspace>>,
    Path(id): Path<String>,
    Query(query): Query<ReadQuery>,
) -> Result<Json<View>, ApiError> {
    Ok(Json(if query.cached {
        ws.claude_mcp_status_cached(&id).await?
    } else {
        ws.claude_mcp_status(&id, false).await?
    }))
}

async fn refresh(
    ApiState(ws): ApiState<Arc<Workspace>>,
    Path(id): Path<String>,
) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.claude_mcp_status(&id, true).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route(
        "/api/agents/{id}/claude/mcp-status",
        get(read).post(refresh),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    async fn until(done: impl Fn() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(done(), "fixture condition timed out");
    }

    fn mode(dir: &Path, value: serde_json::Value) {
        std::fs::write(
            dir.join("mcp-mode.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }

    /// GET …/mcp-status?cached=true, as Settings asks it.
    async fn cached_over_http(ws: &Arc<Workspace>, id: &str) -> serde_json::Value {
        use tower::ServiceExt;
        let response = router()
            .with_state(ws.clone())
            .oneshot(
                axum::http::Request::get(format!("/api/agents/{id}/claude/mcp-status?cached=true"))
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn count(dir: &Path, name: &str) -> usize {
        std::fs::read_to_string(dir.join(name))
            .unwrap_or_default()
            .lines()
            .count()
    }

    #[test]
    fn observations_expire_and_do_not_cross_agent_session_environment_or_generation() {
        let state = State::default();
        let scope = Scope {
            cwd: "/a".into(),
            session: Some("s".into()),
            machine: None,
            generation: Some(1),
        };
        let entry = state.entry("a", &scope);
        let at = Instant::now();
        entry.cache.lock().unwrap().observation = Some((
            at,
            Observation {
                observed_at: crate::model::now(),
                servers: vec![],
                total: 0,
                truncated: false,
            },
        ));
        let context = Context {
            scope: scope.clone(),
            connection: None,
            unavailable: None,
        };
        assert_eq!(entry.view(&context, at).state, "ready");
        assert_eq!(entry.view(&context, at + FRESH_FOR).state, "stale");
        assert!(state
            .entry("b", &scope)
            .view(&context, at)
            .observation
            .is_none());
        for changed in [
            Scope {
                cwd: "/b".into(),
                ..scope.clone()
            },
            Scope {
                session: Some("other".into()),
                ..scope.clone()
            },
            Scope {
                machine: Some("remote".into()),
                ..scope.clone()
            },
            Scope {
                generation: Some(2),
                ..scope.clone()
            },
        ] {
            state.entry("a", &scope);
            assert!(!Arc::ptr_eq(&state.entry("a", &changed), &entry));
            assert!(state
                .entry("a", &changed)
                .view(&context, at)
                .observation
                .is_none());
        }
    }

    /// T-30 fix: Claude Code names a new session on a SessionStart hook
    /// before any turn, while Core names it only from a turn's events. Until
    /// then the connection's own session is the Agent's; a session that
    /// changes during a read, or one other than the session Core has named,
    /// is still refused.
    #[tokio::test]
    async fn a_session_named_on_a_hook_before_core_names_one_is_the_agents_own() {
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                if let Some(value) = &self.0 {
                    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", value);
                } else {
                    std::env::remove_var("YUZUNO_CLAUDE_BRIDGE");
                }
            }
        }
        const HOOKED: &str = "e0e0e0e0-0000-4000-8000-000000000030";
        const SWITCHED: &str = "e0e0e0e0-0000-4000-8000-000000000031";
        const NAMED: &str = "e0e0e0e0-0000-4000-8000-000000000032";
        let _env = crate::claude::BRIDGE_ENV.lock().await;
        let _restore = Restore(std::env::var_os("YUZUNO_CLAUDE_BRIDGE"));
        std::env::set_var(
            "YUZUNO_CLAUDE_BRIDGE",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/claude_mcp_bridge.mjs"
            ),
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        mode(
            path,
            json!({"earlyHook": HOOKED, "servers":[{"name":"fresh", "status":"connected"}]}),
        );
        let ws = Workspace::new(
            path.join("data"),
            path.to_string_lossy().into(),
            "unused".into(),
        )
        .unwrap();
        let agent = ws
            .claude_create(
                "MCP fixture".into(),
                String::new(),
                path.to_string_lossy().into(),
                "fixture".into(),
                None,
            )
            .await
            .unwrap();
        let id = agent.id.as_str();
        until(|| ws.store.agent(id).unwrap().connection_state == "connected").await;
        assert_eq!(ws.store.agent(id).unwrap().claude_session_id, None);

        let fresh = ws.claude_mcp_status(id, false).await.unwrap();
        assert_eq!((fresh.state, fresh.reason), ("ready", "observed"));
        assert_eq!(fresh.observation.unwrap().servers[0].name, "fresh");

        // The session changes while a read is held: that reply is refused.
        mode(
            path,
            json!({"hold":true,"servers":[{"name":"across-a-switch", "status":"connected"}]}),
        );
        let late = {
            let ws = ws.clone();
            let id = id.to_owned();
            tokio::spawn(async move { ws.claude_mcp_status(&id, true).await.unwrap() })
        };
        until(|| path.join("reading").exists()).await;
        std::fs::write(path.join("switch-to"), SWITCHED).unwrap();
        // Released only once the bridge itself reports the new session.
        let bridge = ws.claudes.lock().unwrap().get(id).unwrap().bridge.clone();
        let mut reported = serde_json::Value::Null;
        for _ in 0..400 {
            reported = bridge.request(json!({"op":"status"})).await.unwrap()["sessionId"].clone();
            if reported == SWITCHED {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(reported, SWITCHED);
        std::fs::write(path.join("release"), "1").unwrap();
        let refused = late.await.unwrap();
        assert_eq!((refused.state, refused.reason), ("failed", "changed"));
        assert!(refused.observation.is_none());

        // Core has named a session and Claude Code reports another: refused.
        std::fs::remove_file(path.join("reading")).unwrap();
        std::fs::remove_file(path.join("release")).unwrap();
        mode(
            path,
            json!({"servers":[{"name":"named", "status":"connected"}]}),
        );
        let name = |session: &str| {
            let session = session.to_owned();
            ws.store
                .update(id, "test/session-named", &json!({}), move |d| {
                    d.agent.claude_session_id = Some(session)
                })
                .unwrap();
        };
        name(NAMED);
        let other = ws.claude_mcp_status(id, true).await.unwrap();
        assert_eq!((other.state, other.reason), ("failed", "changed"));
        assert!(other.observation.is_none());
        // Once Core names the session Claude Code uses, it is read again.
        name(SWITCHED);
        let agreed = ws.claude_mcp_status(id, false).await.unwrap();
        assert_eq!((agreed.state, agreed.reason), ("ready", "observed"));
        assert_eq!(agreed.observation.unwrap().servers[0].name, "named");
        assert_eq!(count(path, "starts"), 1, "status never starts a runtime");
        assert_eq!(count(path, "prompts"), 0);
    }

    #[tokio::test]
    async fn live_bridge_read_cache_refresh_disconnect_and_generation_fence_without_prompts() {
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                if let Some(value) = &self.0 {
                    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", value);
                } else {
                    std::env::remove_var("YUZUNO_CLAUDE_BRIDGE");
                }
            }
        }
        let _env = crate::claude::BRIDGE_ENV.lock().await;
        let _restore = Restore(std::env::var_os("YUZUNO_CLAUDE_BRIDGE"));
        std::env::set_var(
            "YUZUNO_CLAUDE_BRIDGE",
            concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/tests/fixtures/claude_mcp_bridge.mjs"
            ),
        );
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        mode(
            path,
            json!({"servers":[
            {"name":"local", "status":"connected", "config":{"env":{"TOKEN":"native-secret"}}},
            {"name":"oauth", "status":"needs-auth"}, {"name":"starting", "status":"pending"},
            {"name":"off", "status":"disabled"}, {"name":"future", "status":"future"},
            {"name":"bad", "status":"failed", "error":"401 native-secret"}]}),
        );
        let ws = Workspace::new(
            path.join("data"),
            path.to_string_lossy().into(),
            "unused".into(),
        )
        .unwrap();
        let agent = ws
            .claude_create(
                "MCP fixture".into(),
                String::new(),
                path.to_string_lossy().into(),
                "fixture".into(),
                None,
            )
            .await
            .unwrap();
        let id = agent.id.as_str();
        until(|| ws.store.agent(id).unwrap().connection_state == "connected").await;
        // T-191: an overview's cached read never asks the SDK, even before
        // anything was read; it says nothing was observed.
        let cached = cached_over_http(&ws, id).await;
        assert_eq!(
            (&cached["state"], &cached["reason"], &cached["observation"]),
            (&json!("unknown"), &json!("not_observed"), &json!(null))
        );
        assert_eq!(count(path, "reads"), 0, "a cached read asks nothing");
        let first = ws.claude_mcp_status(id, false).await.unwrap();
        assert_eq!(first.state, "ready");
        assert_eq!(
            first
                .observation
                .as_ref()
                .unwrap()
                .servers
                .iter()
                .map(|s| s.status.clone())
                .collect::<Vec<_>>(),
            vec![
                Status::Connected,
                Status::NeedsAuth,
                Status::Pending,
                Status::Disabled,
                Status::Unknown,
                Status::Failed
            ]
        );
        assert!(!serde_json::to_string(&first)
            .unwrap()
            .contains("native-secret"));
        for _ in 0..3 {
            assert_eq!(
                ws.claude_mcp_status(id, false).await.unwrap().state,
                "ready"
            );
        }
        assert_eq!(
            count(path, "reads"),
            1,
            "mount/read does not repeatedly ask the SDK"
        );
        let cached = cached_over_http(&ws, id).await;
        assert_eq!(cached["state"], "ready");
        assert_eq!(
            cached["observation"]["observedAt"],
            json!(first.observation.as_ref().unwrap().observed_at),
            "the cached read is the last observation"
        );
        assert_eq!(count(path, "reads"), 1);

        mode(
            path,
            json!({"hold":true,"servers":[{"name":"refreshed","status":"connected"}]}),
        );
        let reads: Vec<_> = (0..8)
            .map(|_| {
                let ws = ws.clone();
                let id = id.to_owned();
                tokio::spawn(async move { ws.claude_mcp_status(&id, true).await.unwrap() })
            })
            .collect();
        until(|| path.join("reading").exists()).await;
        tokio::time::sleep(Duration::from_millis(60)).await; // All callers join the held SDK read.
        std::fs::write(path.join("release"), "1").unwrap();
        for read in reads {
            assert_eq!(
                read.await.unwrap().observation.unwrap().servers[0].name,
                "refreshed"
            );
        }
        assert_eq!(
            count(path, "reads"),
            2,
            "concurrent explicit refreshes share one SDK call"
        );

        mode(path, json!({"fail":true}));
        let failed = ws.claude_mcp_status(id, true).await.unwrap();
        assert_eq!(
            (failed.state, failed.reason, failed.stale),
            ("failed", "read_failed", true)
        );
        assert_eq!(failed.observation.unwrap().servers[0].name, "refreshed");
        assert_eq!(
            ws.claude_mcp_status(id, false).await.unwrap().state,
            "failed"
        );
        assert_eq!(count(path, "reads"), 3);

        // The old read completes normally after a generation replacement.
        // Keeping its transport alive makes this stricter than merely killing it.
        std::fs::remove_file(path.join("reading")).unwrap();
        std::fs::remove_file(path.join("release")).unwrap();
        mode(
            path,
            json!({"hold":true,"servers":[{"name":"old-generation","status":"connected"}]}),
        );
        let late = {
            let ws = ws.clone();
            let id = id.to_owned();
            tokio::spawn(async move { ws.claude_mcp_status(&id, true).await.unwrap() })
        };
        until(|| path.join("reading").exists()).await;
        {
            let _owner = ws.owner(id).await;
            ws.claudes.lock().unwrap().get_mut(id).unwrap().generation += 100;
        }
        std::fs::write(path.join("release"), "1").unwrap();
        let ignored = late.await.unwrap();
        assert!(ignored.observation.is_none());
        assert_eq!(ignored.state, "unknown");
        mode(path, json!({}));
        assert_eq!(
            ws.claude_mcp_status(id, true)
                .await
                .unwrap()
                .observation
                .unwrap()
                .servers[0]
                .name,
            "fixture"
        );

        ws.claude_close_runtime(id).await.unwrap();
        let disconnected = ws.claude_mcp_status(id, true).await.unwrap();
        assert_eq!(
            (disconnected.state, disconnected.reason, disconnected.stale),
            ("unavailable", "not_connected", true)
        );
        assert_eq!(disconnected.observation.unwrap().servers[0].name, "fixture");
        let before = count(path, "reads");
        // Offline is said as offline, with the old observation kept as stale.
        let cached = cached_over_http(&ws, id).await;
        assert_eq!(
            (&cached["state"], &cached["reason"], &cached["stale"], &cached["observation"]["servers"][0]["name"]),
            (&json!("unavailable"), &json!("not_connected"), &json!(true), &json!("fixture"))
        );
        assert_eq!(count(path, "reads"), before);
        assert_eq!(count(path, "starts"), 1, "status never starts a runtime");
        ws.claude_reconnect(id).await.unwrap();
        let reconnected = ws.claude_mcp_status(id, false).await.unwrap();
        assert_eq!(reconnected.state, "ready");
        assert_ne!(reconnected.generation, first.generation);
        assert_eq!(count(path, "reads"), before + 1);
        ws.claude_close_runtime(id).await.unwrap();
        mode(path, json!({"unsupported":true}));
        ws.claude_reconnect(id).await.unwrap();
        let unsupported = ws.claude_mcp_status(id, false).await.unwrap();
        assert_eq!(
            (unsupported.state, unsupported.reason),
            ("unsupported", "unsupported")
        );
        assert!(
            unsupported.observation.is_none(),
            "no old-generation observation inherited"
        );
        assert_eq!(count(path, "reads"), before + 1);
        assert_eq!(count(path, "prompts"), 0);
        assert!(ws.store.detail(id).unwrap().turns.is_empty());
        ws.close_agent(id).await.unwrap();
        assert_eq!(
            ws.claude_mcp_status(id, false).await.unwrap().reason,
            "closed"
        );
    }

    /// T-140: a Claude reconnect checks that the Agent is open on its listed
    /// Agent, not its history. A closed one is refused before a bridge
    /// starts; a summary reconnect and reopen answer with the Agent as the
    /// whole record has it, its project included.
    #[tokio::test]
    async fn a_claude_reconnect_checks_the_listed_agent_and_answers_with_it() {
        struct Restore(Option<std::ffi::OsString>);
        impl Drop for Restore {
            fn drop(&mut self) {
                if let Some(value) = &self.0 {
                    std::env::set_var("YUZUNO_CLAUDE_BRIDGE", value);
                } else {
                    std::env::remove_var("YUZUNO_CLAUDE_BRIDGE");
                }
            }
        }
        let _env = crate::claude::BRIDGE_ENV.lock().await;
        let _restore = Restore(std::env::var_os("YUZUNO_CLAUDE_BRIDGE"));
        std::env::set_var("YUZUNO_CLAUDE_BRIDGE", concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/claude_mcp_bridge.mjs"));
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path();
        mode(path, json!({"servers":[{"name":"fresh", "status":"connected"}]}));
        let ws = Workspace::new(path.join("data"), path.to_string_lossy().into(), "unused".into()).unwrap();
        let created = ws.claude_create("Open check".into(), String::new(), path.to_string_lossy().into(), "fixture".into(), None)
            .await.unwrap();
        let id = created.id.as_str();
        until(|| ws.store.agent(id).unwrap().connection_state == "connected").await;
        let project = ws.store.create_project("P", Default::default()).unwrap();
        ws.store.set_agent_project(id, Some(&project.id)).unwrap();
        let same = |answered: &crate::model::Agent| {
            let (answered, whole) = (serde_json::to_value(answered).unwrap(), serde_json::to_value(ws.store.detail(id).unwrap().agent).unwrap());
            for key in ["id", "harness", "closedAt", "connectionState", "claudeSessionId", "projectId", "workSummary"] {
                assert_eq!(answered[key], whole[key], "{key}");
            }
        };
        let answered = ws.reconnect_summary(id).await.unwrap();
        assert_eq!(answered.project_id.as_deref(), Some(project.id.as_str()));
        same(&answered);

        ws.close_agent(id).await.unwrap();
        let refused = ws.reconnect(id).await.unwrap_err();
        assert!(refused.to_string().contains("已关闭"), "{refused}");
        let refused = ws.reconnect_summary(id).await.unwrap_err();
        assert!(refused.to_string().contains("已关闭"), "{refused}");
        assert_eq!(ws.store.agent(id).unwrap().connection_state, "disconnected", "no bridge was started");

        let reopened = ws.reopen_agent_summary(id).await.unwrap();
        assert!(reopened.closed_at.is_none());
        assert_eq!(reopened.project_id.as_deref(), Some(project.id.as_str()));
        until(|| ws.store.agent(id).unwrap().connection_state == "connected").await;
        same(&ws.listed(id).await.unwrap());
        ws.close_agent(id).await.unwrap();
    }
}
