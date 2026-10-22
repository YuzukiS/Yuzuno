//! What a Codex Agent's own MCP servers reported as they started (T-29):
//! the `mcpServer/startupStatus/updated` events of the Agent's thread on its
//! current connection, kept in memory for that connection only and never
//! carried into another. Showing them asks Codex nothing: Codex 0.162.1's
//! `mcpServerStatus/list` starts every configured server afresh to list it
//! (a threadless `McpConnectionSet` with eager startup), which reading must
//! not do. So this lists startup states only: no tools, no authentication,
//! and nothing about a server that has not reported.
use crate::{server::ApiError, workspace::Workspace};
use anyhow::Result;
use axum::{
    extract::{Path, State as ApiState},
    routing::get,
    Json, Router,
};
use serde::Serialize;
use serde_json::Value;
use std::{collections::{BTreeMap, HashMap}, sync::{Arc, Mutex}};

/// Servers one connection keeps; any more are counted, not kept.
const MAX_SERVERS: usize = 200;
const MAX_NAME: usize = 200;
const MAX_ERROR: usize = 1000;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Server {
    name: String,
    /// starting, ready, failed or cancelled, as Codex says; else unknown.
    status: &'static str,
    error: Option<String>,
    failure_reason: Option<String>,
    observed_at: String,
}

#[derive(Default)]
struct Observed {
    generation: u64,
    servers: BTreeMap<String, Server>,
    /// Further servers that reported, beyond MAX_SERVERS.
    dropped: usize,
}

/// Per Agent: what its current connection's servers last reported.
#[derive(Default)]
pub(crate) struct State(Mutex<HashMap<String, Observed>>);

fn clip(text: &str, max: usize) -> String {
    text.chars().map(|c| if c.is_control() { ' ' } else { c }).take(max).collect()
}

impl State {
    /// One startup report of connection `generation` for the Agent's own
    /// thread. A report of a newer connection starts afresh; one of an older
    /// connection, arriving late, is not this connection's.
    pub(crate) fn observe(&self, id: &str, generation: u64, p: &Value) {
        let Some(name) = p["name"].as_str().filter(|n| !n.is_empty()) else { return };
        let status = match p["status"].as_str() {
            Some("starting") => "starting",
            Some("ready") => "ready",
            Some("failed") => "failed",
            Some("cancelled") => "cancelled",
            _ => "unknown",
        };
        let mut agents = self.0.lock().unwrap();
        let observed = agents.entry(id.to_owned()).or_default();
        if generation < observed.generation {
            return;
        }
        if observed.generation != generation {
            *observed = Observed { generation, ..Default::default() };
        }
        let name = clip(name, MAX_NAME);
        if !observed.servers.contains_key(&name) && observed.servers.len() >= MAX_SERVERS {
            observed.dropped += 1;
            return;
        }
        observed.servers.insert(name.clone(), Server {
            name,
            status,
            error: p["error"].as_str().map(|e| clip(e, MAX_ERROR)),
            failure_reason: p["failureReason"].as_str().map(|r| clip(r, 64)),
            observed_at: crate::model::now(),
        });
    }

    /// The Agent's connection was replaced or ended: what it reported goes.
    pub(crate) fn forget(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }

    fn servers(&self, id: &str, generation: u64) -> (Vec<Server>, usize) {
        let agents = self.0.lock().unwrap();
        agents.get(id).filter(|o| o.generation == generation)
            .map_or_else(Default::default, |o| (o.servers.values().cloned().collect(), o.dropped))
    }
}

/// The panel's read: what this connection's servers reported, or why
/// there is no connection to have reported anything.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// observed, unavailable or unsupported.
    state: &'static str,
    reason: &'static str,
    generation: Option<u64>,
    servers: Vec<Server>,
    /// Servers that reported beyond those listed.
    more: usize,
}

impl View {
    fn not(state: &'static str, reason: &'static str) -> Self {
        Self { state, reason, generation: None, servers: vec![], more: 0 }
    }
}

impl Workspace {
    /// This Codex Agent's MCP servers as they reported starting on its
    /// current connection. Nothing is sent to Codex or started for this.
    pub async fn codex_mcp(self: &Arc<Self>, id: &str) -> Result<View> {
        let agent = self.detail(id).await?.agent;
        if agent.harness != "codex" {
            return Ok(View::not("unsupported", "harness"));
        }
        if agent.closed_at.is_some() {
            return Ok(View::not("unavailable", "closed"));
        }
        let generation = self.rpcs.lock().unwrap().get(id)
            .filter(|c| !c.closing && agent.connection_state == "connected").map(|c| c.generation);
        let Some(generation) = generation else {
            return Ok(View::not("unavailable", "not_connected"));
        };
        let (servers, more) = self.codex_mcp.servers(id, generation);
        Ok(View { state: "observed", reason: "startup_reports", generation: Some(generation), servers, more })
    }
}

async fn read_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.codex_mcp(&id).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new().route("/api/agents/{id}/codex/mcp", get(read_route))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn each_server_keeps_its_latest_report_for_its_own_connection_only() {
        let state = State::default();
        state.observe("a", 3, &json!({"threadId":"t","name":"docs","status":"starting","error":null,"failureReason":null}));
        state.observe("a", 3, &json!({"threadId":"t","name":"docs","status":"failed","error":"spawn\u{7}failed","failureReason":"reauthenticationRequired"}));
        state.observe("a", 3, &json!({"threadId":"t","name":"api","status":"ready"}));
        state.observe("a", 3, &json!({"threadId":"t","name":"odd","status":"exploded"}));
        state.observe("a", 3, &json!({"threadId":"t","status":"ready"}));
        let (servers, more) = state.servers("a", 3);
        assert_eq!(servers.iter().map(|s| (s.name.as_str(), s.status, s.error.as_deref(), s.failure_reason.as_deref())).collect::<Vec<_>>(), [
            ("api", "ready", None, None), ("docs", "failed", Some("spawn failed"), Some("reauthenticationRequired")), ("odd", "unknown", None, None),
        ]);
        assert_eq!(more, 0);
        assert!(state.servers("a", 4).0.is_empty(), "another connection has reported nothing yet");
        state.observe("a", 4, &json!({"threadId":"t","name":"api","status":"starting"}));
        assert_eq!(state.servers("a", 4).0.len(), 1);
        assert!(state.servers("a", 3).0.is_empty(), "the old connection's reports are gone");
        state.observe("a", 3, &json!({"threadId":"t","name":"late","status":"ready"}));
        assert_eq!(state.servers("a", 4).0.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(), ["api"], "a late report of the old connection is not mixed in");
        state.forget("a");
        assert!(state.servers("a", 4).0.is_empty());
        for i in 0..MAX_SERVERS + 2 { state.observe("b", 1, &json!({"name":format!("s{i}"),"status":"ready"})); }
        let (servers, more) = state.servers("b", 1);
        assert_eq!((servers.len(), more), (MAX_SERVERS, 2));
    }
}
