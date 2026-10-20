//! Harness-only MCP boundary. Protocol and Streamable HTTP are provided by rmcp.
//!
//! This router must be merged *outside* the browser/desktop-header middleware.
//! Every HTTP request authenticates one persisted Agent identity; MCP sessions,
//! clientInfo, tool arguments and protocol metadata never establish identity.

use crate::{store::Store, workspace::Workspace};
use anyhow::{bail, Context, Result};
use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::{header, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
    Router,
};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, RoleServer, ServerHandler,
};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Arc, Weak};
use subtle::ConstantTimeEq;
use tower::ServiceExt;

const MAX_BODY_BYTES: usize = 128 * 1024;
const CREDENTIAL_PREFIX: &str = "collaboration.mcp.agent.";

#[derive(Clone)]
enum WorkspaceOwner {
    Strong(Arc<Workspace>),
    Weak(Weak<Workspace>),
}

impl WorkspaceOwner {
    fn upgrade(&self) -> Option<Arc<Workspace>> {
        match self {
            Self::Strong(ws) => Some(ws.clone()),
            Self::Weak(ws) => ws.upgrade(),
        }
    }
}

#[derive(Clone)]
struct Boundary {
    ws: WorkspaceOwner,
    tools: Arc<Vec<Tool>>,
    config: StreamableHttpServerConfig,
}

/// An independent, authenticated MCP router; it exposes no credentials via HTTP.
pub fn router(ws: Arc<Workspace>, port: u16) -> Router {
    router_with_owner(WorkspaceOwner::Strong(ws), port)
}

/// The separately served remote endpoint cannot keep Workspace alive by itself.
/// `port` is the SSH-visible authority, not the listener's ephemeral local port.
pub(crate) fn remote_router(ws: Weak<Workspace>, port: u16) -> Router {
    router_with_owner(WorkspaceOwner::Weak(ws), port)
}

fn router_with_owner(ws: WorkspaceOwner, port: u16) -> Router {
    let tools = crate::collaboration_store::tool_definitions()
        .into_iter()
        .map(|definition| serde_json::from_value(definition).expect("valid collaboration MCP tool"))
        .collect();
    let config = StreamableHttpServerConfig::default()
        .with_legacy_session_mode(false)
        .with_json_response(true)
        .with_sse_keep_alive(None)
        .with_allowed_hosts([format!("127.0.0.1:{port}"), format!("localhost:{port}")])
        .enforce_origin_validation()
        .with_max_request_body_bytes(MAX_BODY_BYTES);
    Router::new()
        .route("/mcp/{agent_id}", any(serve))
        .with_state(Boundary {
            ws,
            tools: Arc::new(tools),
            config,
        })
}

async fn serve(
    State(boundary): State<Boundary>,
    Path(agent_id): Path<String>,
    request: Request,
) -> Response {
    // There is no browser use case for a Harness credential. Reject every
    // present Origin, including null, before inspecting credentials.
    if request.headers().contains_key(header::ORIGIN) {
        return (
            StatusCode::FORBIDDEN,
            "MCP is available only to configured Harness clients",
        )
            .into_response();
    }
    // A session identifier must never become an alternate authorization path.
    // Stateless SDK clients receive no session ID from this endpoint.
    if request.headers().contains_key("mcp-session-id") {
        return (
            StatusCode::BAD_REQUEST,
            "This MCP endpoint does not use sessions",
        )
            .into_response();
    }
    let Some(ws) = boundary.ws.upgrade() else {
        return (StatusCode::SERVICE_UNAVAILABLE, "Workspace is closed").into_response();
    };
    let headers = request.headers();
    let token = if headers.get_all(header::AUTHORIZATION).iter().count() == 1 {
        headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
    } else {
        None
    };
    let authorized = match token.map(str::to_owned) {
        Some(token) => {
            let agent = agent_id.clone();
            ws.stored(move |store| store.collaboration_mcp_authorized(&agent, &token)).await.unwrap_or(false)
        }
        None => false,
    };
    if !authorized {
        return (
            StatusCode::UNAUTHORIZED,
            [(
                header::WWW_AUTHENTICATE,
                "Bearer realm=\"yuzuno-collaboration\"",
            )],
            "Invalid or unavailable Agent credential",
        )
            .into_response();
    }
    let handler = CollaborationHandler {
        ws,
        actor: agent_id,
        tools: boundary.tools,
    };
    // The official transport owns parsing, negotiation, notifications, request
    // limits and response encoding. Each request gets a new fixed actor;
    // no MCP session registry or background transport process is retained.
    let service: StreamableHttpService<CollaborationHandler, LocalSessionManager> =
        StreamableHttpService::new(
            move || Ok(handler.clone()),
            Default::default(),
            boundary.config,
        );
    match service.oneshot(request).await {
        Ok(response) => response.map(Body::new),
        Err(error) => match error {},
    }
}

/// Sent once per connection. Like every tool description it stays within
/// what the shortest supported client shows whole (results::max_description_length).
const INSTRUCTIONS: &str = "Your Agent identity is fixed by Yuzuno. Use peer_read when notified of new mail. \
    A task is an outcome, not a turn: finishing a turn does not complete a task. \
    Submit results with task_submit_result; keep the same task across retries. \
    For dispatched work retain dispatchId from the assignment message; result notification is automatic. \
    result_publish optionally shows the user a table or chart; plain answers need no tool. \
    result_guide has its full component guide.";

/// The server instructions: the collaboration rules and where the working
/// guide is (T-131), then the Project Brief's hard rules (T-85). Claude
/// re-announces server instructions after a compaction, so the rules survive it.
fn server_instructions() -> String {
    format!("{INSTRUCTIONS} {}\n\n{}", crate::guide::INSTRUCTION, crate::project_brief::hard_rules())
}

#[derive(Clone)]
struct CollaborationHandler {
    ws: Arc<Workspace>,
    actor: String,
    tools: Arc<Vec<Tool>>,
}

impl ServerHandler for CollaborationHandler {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "yuzuno-collaboration",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(server_instructions())
    }

    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tools.iter().find(|tool| tool.name == name).cloned()
    }

    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        _context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let mut result = ListToolsResult::default();
        result.tools = self.tools.as_ref().clone();
        Ok(result)
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        _context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let tool = self
            .get_tool(&request.name)
            .ok_or_else(|| ErrorData::invalid_params("Unknown collaboration tool", None))?;
        let mut arguments = request.arguments.unwrap_or_default();
        // These tools have a closed set of top-level parameters. Reject unknown
        // keys (including source/actor overrides), rather than silently accepting
        // a claimed sender. Domain validation remains in the shared Store path.
        let properties = tool
            .input_schema
            .get("properties")
            .and_then(Value::as_object);
        if let Some(key) = arguments
            .keys()
            .find(|key| !properties.is_some_and(|properties| properties.contains_key(*key)))
        {
            return Ok(CallToolResult::structured_error(json!({
                "error": format!("Unknown argument: {key}. Your Agent identity is supplied by Yuzuno.")
            })).into());
        }
        // Read-only and the same for every Agent: the guide needs no Turn.
        if request.name == crate::results::GUIDE_TOOL {
            return Ok(match crate::results::guide(&Value::Object(arguments)) {
                Ok(guide) => CallToolResult::structured(guide),
                Err(problem) => CallToolResult::structured_error(problem),
            }
            .into());
        }
        // So is the working guide.
        if request.name == crate::guide::TOOL {
            return Ok(match crate::guide::answer(&Value::Object(arguments)) {
                Ok(guide) => CallToolResult::structured(guide),
                Err(problem) => CallToolResult::structured_error(problem),
            }
            .into());
        }
        // A rejected result is the Agent's to fix: its problems are the answer.
        if request.name == crate::results::TOOL {
            return Ok(match self.ws.result_publish(&self.actor, Value::Object(arguments)).await {
                Ok(Ok(published)) => CallToolResult::structured(published),
                Ok(Err(rejected)) => CallToolResult::structured_error(rejected),
                Err(error) => CallToolResult::structured_error(json!({"error": error.to_string()})),
            }
            .into());
        }
        // So is a rejected Brief update: its problems, and on a version
        // conflict the latest Brief.
        if request.name == crate::project_brief::UPDATE_TOOL {
            return Ok(match crate::project_brief::update_tool(&self.ws, &self.actor, Value::Object(arguments)).await {
                Ok(Ok(accepted)) => CallToolResult::structured(accepted),
                Ok(Err(rejected)) => CallToolResult::structured_error(rejected),
                Err(error) => CallToolResult::structured_error(json!({"error": error.to_string()})),
            }
            .into());
        }
        // An Agent's default views and short receipts (mcp_views.rs).
        let review_view = match crate::mcp_views::prepare(&request.name, &mut arguments) {
            Ok(view) => view,
            Err(error) => return Ok(CallToolResult::structured_error(json!({"error": error})).into()),
        };
        match self
            .ws
            .collaboration_call(Some(&self.actor), &request.name, Value::Object(arguments))
            .await
        {
            Ok(result) => {
                let mut result = crate::mcp_views::answer(&request.name, result, review_view.as_deref());
                // Probe provenance is public identity, never a credential.
                // Readiness requires a successful tool call through this Core
                // epoch, not a cached tool catalog from a previous process.
                // activeTurnId is the caller's running Turn when Core can
                // vouch for it (see results::reliable_turn), else null.
                if request.name == "peers_list" {
                    let actor = self.actor.clone();
                    let (workspace, turn) = self.ws.stored(move |store| {
                        let turn = crate::results::reliable_turn(store, &*store.db.read()?, &actor)?;
                        Ok((store.workspace_id()?, turn.map(|turn| turn.turn)))
                    }).await
                        .map_err(|_| ErrorData::internal_error("Workspace identity unavailable", None))?;
                    result["yuzuno"] = json!({"workspaceId":workspace,
                        "agentId":self.actor,"credentialEpoch":self.ws.collaboration_epoch,
                        "activeTurnId":turn});
                }
                Ok(CallToolResult::structured(result).into())
            }
            Err(error) => {
                Ok(CallToolResult::structured_error(json!({"error": error.to_string()})).into())
            }
        }
    }
}

/// Native Harness configuration only. Do not include this value in Agent JSON,
/// journaling, SSE events, errors or public API responses.
pub fn agent_http_config(ws: &Workspace, id: &str, base_url: &str) -> Result<Value> {
    agent_http_config_in(&ws.store, id, base_url)
}

/// `agent_http_config` for a store job (it may create the credential).
pub(crate) fn agent_http_config_in(store: &Store, id: &str, base_url: &str) -> Result<Value> {
    let base: Uri = base_url
        .parse()
        .context("Invalid collaboration endpoint URL")?;
    if !matches!(base.scheme_str(), Some("http" | "https"))
        || !matches!(base.host(), Some("127.0.0.1" | "localhost"))
        || base.path() != "/"
        || base.query().is_some()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        || id.is_empty()
    {
        bail!("Collaboration endpoint must be a loopback base URL with a valid Agent ID");
    }
    let token = store.collaboration_mcp_token(id)?;
    Ok(json!({
        "url": format!("{}/mcp/{id}", base_url.trim_end_matches('/')),
        "headers": {"Authorization": format!("Bearer {token}")},
    }))
}

impl Store {
    /// Called exactly once after the Workspace lock has been acquired, before
    /// any listener or runtime can attach. New credentials are minted lazily
    /// through the existing per-Agent path. No old token remains authorized.
    pub(crate) fn rotate_collaboration_mcp_credentials(&self) -> Result<()> {
        self.db.write()?.execute(
            "DELETE FROM workspace_meta WHERE key GLOB 'collaboration.mcp.agent.*'",
            [],
        )?;
        Ok(())
    }

    /// Read on a reader (no record is parsed); the writer is taken only the
    /// first time, to create the credential.
    fn collaboration_mcp_token(&self, id: &str) -> Result<String> {
        let key = format!("{CREDENTIAL_PREFIX}{id}");
        // Whether the Agent is closed, and its credential if it has one.
        let lookup = |db: &rusqlite::Connection| -> Result<Option<String>> {
            let (closed, token): (bool, Option<String>) = db.query_row(
                "SELECT json_extract(a.data,'$.agent.closedAt') IS NOT NULL, m.value
                 FROM agents a LEFT JOIN workspace_meta m ON m.key=?2 WHERE a.id=?1",
                params![id, key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )?;
            if closed {
                bail!("Closed Agents cannot receive MCP credentials");
            }
            Ok(token)
        };
        if let Some(token) = lookup(&*self.db.read()?)? {
            return Ok(token);
        }
        let db = self.db.write()?;
        lookup(&db)?;
        // UUID v4 uses OS randomness. Two UUIDs supply 244 random bits; no
        // credential derives from an Agent ID, name, session or PID.
        db.execute(
            "INSERT OR IGNORE INTO workspace_meta(key,value) VALUES(?1,?2)",
            params![
                key,
                format!(
                    "{}{}",
                    uuid::Uuid::new_v4().simple(),
                    uuid::Uuid::new_v4().simple()
                )
            ],
        )?;
        Ok(db.query_row(
            "SELECT value FROM workspace_meta WHERE key=?1",
            [key],
            |row| row.get(0),
        )?)
    }

    fn collaboration_mcp_authorized(&self, id: &str, token: &str) -> Result<bool> {
        // Every MCP call is checked here: the listed view, never the record,
        // on a reader.
        let db = self.db.read()?;
        let expected: Option<String> = db.query_row(
            "SELECT value FROM workspace_meta WHERE key=?1",
            [format!("{CREDENTIAL_PREFIX}{id}")],
            |row| row.get(0),
        ).optional()?;
        let Some(expected) = expected else {
            return Ok(false);
        };
        let Some(brief) = self.brief_in(&db, id)? else {
            return Ok(false);
        };
        Ok(brief.agent.closed_at.is_none()
            && bool::from(expected.as_bytes().ct_eq(token.as_bytes())))
    }
}

#[cfg(test)]
mod dispatch_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AgentDetail;
    use axum::http::Request as HttpRequest;
    use rmcp::{
        transport::{
            streamable_http_client::StreamableHttpClientTransportConfig,
            StreamableHttpClientTransport,
        },
        ServiceExt as _,
    };
    use std::time::Duration;

    fn fixture() -> (tempfile::TempDir, Arc<Workspace>) {
        let directory = tempfile::tempdir().unwrap();
        let ws = Workspace::new(
            directory.path().to_owned(),
            "/tmp".into(),
            "unused-harness".into(),
        )
        .unwrap();
        for id in ["agent-a", "agent-b"] {
            let detail: AgentDetail = serde_json::from_value(json!({
                "agent": {
                    "id": id, "name": id, "cwd": "/tmp", "model": "test", "color": "sage",
                    "threadId": null, "status": "offline", "createdAt": "2026-10-12T00:00:00Z",
                    "updatedAt": "2026-10-12T00:00:00Z", "unreadCount": 0, "pendingCount": 0,
                    "lastMessage": null, "lastSeq": 0, "reviewedSeq": 0, "error": null
                }, "turns": [], "pending": [], "artifacts": []
            }))
            .unwrap();
            ws.store.insert(&detail).unwrap();
        }
        (directory, ws)
    }

    fn request(id: &str, token: Option<&str>) -> axum::http::request::Builder {
        let mut builder = HttpRequest::builder()
            .method("POST")
            .uri(format!("/mcp/{id}"))
            .header(header::HOST, "127.0.0.1:4321")
            .header(header::CONTENT_TYPE, "application/json")
            .header(header::ACCEPT, "application/json, text/event-stream");
        if let Some(token) = token {
            builder = builder.header(header::AUTHORIZATION, format!("Bearer {token}"));
        }
        builder
    }

    fn list_request() -> Value {
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}})
    }

    #[tokio::test]
    async fn core_restart_rotates_credentials_and_never_reuses_them_for_an_existing_agent() {
        let (directory, ws) = fixture();
        let old = ws.store.collaboration_mcp_token("agent-a").unwrap();
        assert!(ws.store.collaboration_mcp_authorized("agent-a", &old).unwrap());
        let epoch = ws.collaboration_epoch.clone();
        let workspace = ws.store.workspace_id().unwrap();
        drop(ws);
        let ws = Workspace::new(directory.path().to_owned(), "/tmp".into(), "unused-harness".into()).unwrap();
        assert_ne!(epoch, ws.collaboration_epoch);
        assert_eq!(workspace, ws.store.workspace_id().unwrap());
        assert!(!ws.store.collaboration_mcp_authorized("agent-a", &old).unwrap());
        let fresh = ws.store.collaboration_mcp_token("agent-a").unwrap();
        assert!(old != fresh); // Boolean assertions never echo either token.
        assert!(ws.store.collaboration_mcp_authorized("agent-a", &fresh).unwrap());
        for (candidate, status) in [(&old, StatusCode::UNAUTHORIZED), (&fresh, StatusCode::OK)] {
            let response = router(ws.clone(), 4321).oneshot(
                request("agent-a", Some(candidate)).body(Body::from(list_request().to_string())).unwrap()
            ).await.unwrap();
            assert_eq!(response.status(), status);
        }
    }

    #[tokio::test]
    async fn rejects_missing_wrong_cross_agent_and_closed_credentials() {
        let (_directory, ws) = fixture();
        let token = ws.store.collaboration_mcp_token("agent-a").unwrap();
        let app = router(ws.clone(), 4321);
        for (id, candidate) in [
            ("agent-a", None),
            ("agent-a", Some("wrong")),
            ("agent-b", Some(token.as_str())),
        ] {
            let response = app
                .clone()
                .oneshot(
                    request(id, candidate)
                        .body(Body::from(list_request().to_string()))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        }
        ws.store
            .update("agent-a", "workspace/closed", &json!({}), |detail| {
                detail.agent.closed_at = Some("2026-10-12T00:00:00Z".into());
            })
            .unwrap();
        let response = app
            .clone()
            .oneshot(
                request("agent-a", Some(&token))
                    .body(Body::from(list_request().to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(agent_http_config(&ws, "agent-a", "http://127.0.0.1:4321").is_err());
        ws.store.delete_closed_agent("agent-a").unwrap();
        assert!(!ws
            .store
            .collaboration_mcp_authorized("agent-a", &token)
            .unwrap());
    }

    #[tokio::test]
    async fn rejects_browser_origins_sessions_hosts_and_oversized_bodies() {
        let (_directory, ws) = fixture();
        let token = ws.store.collaboration_mcp_token("agent-a").unwrap();
        let app = router(ws, 4321);
        for (name, value, expected) in [
            ("origin", "https://evil.example", StatusCode::FORBIDDEN),
            ("origin", "null", StatusCode::FORBIDDEN),
            (
                "mcp-session-id",
                "another-agents-session",
                StatusCode::BAD_REQUEST,
            ),
            ("host", "evil.example:4321", StatusCode::FORBIDDEN),
        ] {
            let mut req = request("agent-a", Some(&token))
                .body(Body::from(list_request().to_string()))
                .unwrap();
            req.headers_mut().insert(
                axum::http::HeaderName::from_static(name),
                value.parse().unwrap(),
            );
            let response = app.clone().oneshot(req).await.unwrap();
            assert_eq!(response.status(), expected, "header {name}");
        }
        let response = app
            .oneshot(
                request("agent-a", Some(&token))
                    .body(Body::from("x".repeat(MAX_BODY_BYTES + 1)))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn harness_configuration_is_private_stable_within_epoch_and_rotates_after_restart() {
        let (directory, ws) = fixture();
        let config = agent_http_config(&ws, "agent-a", "http://127.0.0.1:4321").unwrap();
        assert_eq!(config["url"], "http://127.0.0.1:4321/mcp/agent-a");
        assert!(
            config ==
            agent_http_config(&ws, "agent-a", "http://127.0.0.1:4321/").unwrap()
        );
        assert!(
            config["headers"] !=
            agent_http_config(&ws, "agent-b", "http://127.0.0.1:4321").unwrap()["headers"]
        );
        assert!(agent_http_config(&ws, "agent-a", "http://evil.example").is_err());
        let agent_json = serde_json::to_string(&ws.store.detail("agent-a").unwrap()).unwrap();
        let credential = config["headers"]["Authorization"].as_str().unwrap();
        assert!(!agent_json.contains(credential));
        drop(ws);
        let reopened = Workspace::new(
            directory.path().to_owned(),
            "/tmp".into(),
            "unused-harness".into(),
        )
        .unwrap();
        assert!(
            config !=
            agent_http_config(&reopened, "agent-a", "http://127.0.0.1:4321").unwrap()
        );
    }

    #[tokio::test]
    async fn an_agent_reads_the_current_task_and_short_receipts_while_the_gui_keeps_whole_records() {
        let (_directory, ws) = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = ws.store.collaboration_mcp_token("agent-a").unwrap();
        let app = router(ws.clone(), port);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let transport = StreamableHttpClientTransport::with_client(
            reqwest::Client::builder().timeout(Duration::from_secs(5)).build().unwrap(),
            StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp/agent-a")).auth_header(token),
        );
        let client = tokio::time::timeout(Duration::from_secs(10), ().serve(transport)).await.unwrap().unwrap();
        let call = |name: &'static str, arguments: Value| {
            CallToolRequestParams::new(name).with_arguments(arguments.as_object().unwrap().clone())
        };
        let created = client.call_tool(call("task_create", json!({"requestId":"c","title":"Ship it","description":"d".repeat(3000)})))
            .await.unwrap().structured_content.unwrap();
        assert_eq!((created["task"]["id"].clone(), created["task"]["version"].clone()), (json!("T-1"), json!(1)));
        assert!(created["task"].get("description").is_none(), "a receipt, not the task: {created}");
        let note = call("task_comment", json!({"requestId":"n","taskId":"T-1","body":"progress"}));
        let first = client.call_tool(note.clone()).await.unwrap().structured_content.unwrap();
        let again = client.call_tool(note).await.unwrap().structured_content.unwrap();
        assert_eq!(first, again, "a retry is answered from the stored receipt, the same way");
        assert_eq!(first["activity"]["kind"], "comment");
        let current = client.call_tool(call("task_get", json!({"taskId":"T-1"}))).await.unwrap().structured_content.unwrap();
        assert_eq!(current["current"]["version"], 1);
        assert_eq!(current["current"]["latestActivity"]["seq"], first["activity"]["seq"]);
        let full = client.call_tool(call("task_get", json!({"taskId":"T-1","view":"full"}))).await.unwrap().structured_content.unwrap();
        assert!(full["task"]["description"].as_str().unwrap().len() == 3000 && full["executions"].is_array());
        let page = client.call_tool(call("task_get", json!({"taskId":"T-1","limit":1}))).await.unwrap().structured_content.unwrap();
        assert_eq!((page["activities"].as_array().unwrap().len(), page["hasMore"].clone()), (1, json!(true)));
        // The GUI (no Agent) keeps the whole record and the whole receipt.
        let gui = ws.collaboration_call(None, "task_get", json!({"taskId":"T-1"})).await.unwrap();
        assert!(gui["task"]["description"].is_string() && gui["activities"].is_array());
        let gui_note = ws.collaboration_call(None, "task_comment", json!({"requestId":"g","taskId":"T-1","body":"x"})).await.unwrap();
        assert!(gui_note["task"]["description"].is_string());
        let _ = client.cancel().await;
        server.abort();
    }

    #[tokio::test]
    async fn official_sdk_client_lists_calls_and_cannot_claim_another_identity() {
        let (_directory, ws) = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = ws.store.collaboration_mcp_token("agent-a").unwrap();
        let app = router(ws.clone(), port);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let transport = StreamableHttpClientTransport::with_client(
            reqwest::Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap(),
            StreamableHttpClientTransportConfig::with_uri(format!(
                "http://127.0.0.1:{port}/mcp/agent-a"
            ))
            .auth_header(token),
        );
        let client = tokio::time::timeout(Duration::from_secs(10), ().serve(transport))
            .await
            .unwrap()
            .unwrap();
        let tools = client.list_all_tools().await.unwrap();
        assert!(tools.iter().any(|tool| tool.name == "peer_read"));
        assert!(tools.iter().any(|tool| tool.name == "task_submit_result"));
        let result = client
            .call_tool(CallToolRequestParams::new("peers_list"))
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true));
        assert!(result.structured_content.is_some());
        let send = CallToolRequestParams::new("peer_send").with_arguments(
            json!({"requestId":"sdk-message-1","toAgentId":"agent-b","body":"Review the artifact"})
                .as_object()
                .unwrap()
                .clone(),
        );
        let sent = client.call_tool(send.clone()).await.unwrap();
        assert_ne!(sent.is_error, Some(true));
        let sent = sent.structured_content.unwrap();
        assert_eq!(sent["message"]["sender"]["id"], "agent-a");
        assert_eq!(sent["message"]["source"]["agentId"], "agent-a");
        let retried = client
            .call_tool(send)
            .await
            .unwrap()
            .structured_content
            .unwrap();
        assert_eq!(sent["message"]["id"], retried["message"]["id"]);
        let inbox = ws
            .store
            .collaboration_call(Some("agent-b"), "peer_read", json!({}))
            .unwrap();
        assert_eq!(inbox["messages"].as_array().unwrap().len(), 1);
        assert_eq!(inbox["messages"][0]["sender"]["id"], "agent-a");
        let result = client
            .call_tool(
                CallToolRequestParams::new("peers_list").with_arguments(
                    json!({"fromAgentId":"agent-b"})
                        .as_object()
                        .unwrap()
                        .clone(),
                ),
            )
            .await
            .unwrap();
        assert_eq!(result.is_error, Some(true));
        ws.store
            .update("agent-a", "workspace/closed", &json!({}), |detail| {
                detail.agent.closed_at = Some("2026-10-12T00:00:00Z".into());
            })
            .unwrap();
        assert!(client
            .call_tool(CallToolRequestParams::new("peers_list"))
            .await
            .is_err());
        let _ = client.cancel().await;
        server.abort();
    }

    #[tokio::test]
    async fn result_publish_is_listed_pinned_to_the_running_turn_and_rejections_are_errors() {
        let (_directory, ws) = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = ws.store.collaboration_mcp_token("agent-a").unwrap();
        let app = router(ws.clone(), port);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let transport = StreamableHttpClientTransport::with_client(
            reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap(),
            StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp/agent-a"))
                .auth_header(token),
        );
        let client = tokio::time::timeout(Duration::from_secs(10), ().serve(transport)).await.unwrap().unwrap();
        let tools = client.list_all_tools().await.unwrap();
        let tool = tools.iter().find(|tool| tool.name == crate::results::TOOL).unwrap();
        assert!(tool.input_schema["properties"].get("expectedTurnId").is_some());
        let active = || async {
            client.call_tool(CallToolRequestParams::new("peers_list")).await.unwrap()
                .structured_content.unwrap()["yuzuno"]["activeTurnId"].clone()
        };
        assert_eq!(active().await, Value::Null, "an offline Agent has no Turn to publish to");
        // The guide needs no Turn: any Agent reads it, whole or in part.
        let guide = tools.iter().find(|tool| tool.name == crate::results::GUIDE_TOOL).unwrap();
        assert!(guide.input_schema["properties"].get("components").is_some());
        let whole = client.call_tool(CallToolRequestParams::new(crate::results::GUIDE_TOOL)).await.unwrap();
        assert_ne!(whole.is_error, Some(true));
        assert!(whole.structured_content.unwrap()["guide"].as_str().unwrap().contains("- BarChart {"));
        let unknown = client.call_tool(CallToolRequestParams::new(crate::results::GUIDE_TOOL).with_arguments(
            json!({"components":["Chart"]}).as_object().unwrap().clone(),
        )).await.unwrap();
        assert_eq!(unknown.is_error, Some(true));
        ws.store.update("agent-a", "test/running", &json!({}), |d| {
            d.turns.push(json!({"id":"turn-1","status":"inProgress","items":[]}));
            d.agent.status = "working".into();
            d.agent.connection_state = "connected".into();
        }).unwrap();
        assert_eq!(active().await, "turn-1");
        let publish = |request: &str, spec: Value| {
            CallToolRequestParams::new(crate::results::TOOL).with_arguments(
                json!({"requestId":request,"expectedTurnId":"turn-1","spec":spec}).as_object().unwrap().clone(),
            )
        };
        let rejected = client.call_tool(publish("bad", json!({"root":"r","elements":{}}))).await.unwrap();
        assert_eq!(rejected.is_error, Some(true));
        let rejected = rejected.structured_content.unwrap();
        assert_eq!(rejected["problems"][0]["code"], "component_count");
        assert_eq!(rejected["rejectionsLeft"], 2);
        assert_eq!(rejected["guide"]["tool"], crate::results::GUIDE_TOOL);
        let spec = json!({"root":"r","elements":{"r":{"type":"Result","props":{"title":"Done","summary":"One line."}}}});
        let accepted = client.call_tool(publish("good", spec)).await.unwrap();
        assert_ne!(accepted.is_error, Some(true));
        let accepted = accepted.structured_content.unwrap();
        assert_eq!((accepted["turnId"].clone(), accepted["version"].clone()), (json!("turn-1"), json!(1)));
        let claimed = client.call_tool(CallToolRequestParams::new(crate::results::TOOL).with_arguments(
            json!({"requestId":"x","expectedTurnId":"turn-1","spec":{},"agentId":"agent-b"}).as_object().unwrap().clone(),
        )).await.unwrap();
        assert_eq!(claimed.is_error, Some(true));
        let _ = client.cancel().await;
        server.abort();
    }

    #[tokio::test]
    async fn the_working_guide_is_listed_and_answers_any_agent_without_a_turn() {
        let (_directory, ws) = fixture();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let token = ws.store.collaboration_mcp_token("agent-a").unwrap();
        let app = router(ws.clone(), port);
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let transport = StreamableHttpClientTransport::with_client(
            reqwest::Client::builder().timeout(Duration::from_secs(15)).build().unwrap(),
            StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp/agent-a"))
                .auth_header(token),
        );
        let client = tokio::time::timeout(Duration::from_secs(10), ().serve(transport)).await.unwrap().unwrap();
        let info = client.peer_info().unwrap();
        assert!(info.instructions.as_deref().unwrap().contains(crate::guide::TOOL));
        let tools = client.list_all_tools().await.unwrap();
        let tool = tools.iter().find(|tool| tool.name == crate::guide::TOOL).unwrap();
        assert_eq!(tool.input_schema["properties"]["topic"]["enum"][2], "jobs");
        let call = |arguments: Value| {
            let request = CallToolRequestParams::new(crate::guide::TOOL);
            match arguments {
                Value::Object(arguments) => request.with_arguments(arguments),
                _ => request,
            }
        };
        let overview = client.call_tool(call(Value::Null)).await.unwrap();
        assert_ne!(overview.is_error, Some(true));
        let overview = overview.structured_content.unwrap();
        assert_eq!((overview["topic"].clone(), overview["core"]["releaseId"].clone()), (json!("overview"), json!("development")));
        assert_eq!(overview["revision"], crate::guide::revision());
        let jobs = client.call_tool(call(json!({"topic":"jobs"}))).await.unwrap().structured_content.unwrap();
        assert!(jobs["guide"].as_str().unwrap().contains("## Runs of stages"));
        let unknown = client.call_tool(call(json!({"topic":"stages"}))).await.unwrap();
        assert_eq!(unknown.is_error, Some(true));
        assert!(unknown.structured_content.unwrap()["error"].as_str().unwrap().contains("topic is one of"));
        let extra = client.call_tool(call(json!({"topic":"jobs","part":"x"}))).await.unwrap();
        assert_eq!(extra.is_error, Some(true));
        let _ = client.cancel().await;
        server.abort();
    }

    #[test]
    fn the_instructions_fit_the_shortest_supported_client() {
        assert!(INSTRUCTIONS.encode_utf16().count() <= crate::results::max_description_length());
        assert!(INSTRUCTIONS.contains(crate::results::GUIDE_TOOL));
    }

    #[tokio::test]
    async fn server_instructions_carry_the_brief_rules_within_the_harness_limit() {
        let (_directory, ws) = fixture();
        let handler = CollaborationHandler { ws, actor: "agent-a".into(), tools: Arc::new(vec![]) };
        let instructions = handler.get_info().instructions.unwrap();
        // Harnesses cut server instructions at 2048 UTF-16 units, and a
        // compaction re-announces them: the Brief's hard rules must fit whole.
        let units = instructions.encode_utf16().count();
        assert!(units <= crate::results::max_description_length(), "{units}");
        assert!(instructions.ends_with(crate::project_brief::hard_rules()));
        for tool in ["brief_get", "brief_update", "brief_guide", crate::results::GUIDE_TOOL, crate::guide::TOOL] {
            assert!(instructions.contains(tool), "{tool}");
        }
    }
}
