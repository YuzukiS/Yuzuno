use crate::{client_view, workspace::Workspace, model::{AgentSettings, MessageInput}, remote::{self, RemoteMachine}};
use axum::{
    body::Body,
    extract::{DefaultBodyLimit, Path, Query, Request, State},
    http::{header, HeaderMap, Method, StatusCode},
    middleware::{self, Next},
    response::{sse::Event, IntoResponse, Response, Sse},
    routing::{get, patch, post},
    Extension, Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{convert::Infallible, path::PathBuf, sync::Arc};

pub struct ApiError(anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for ApiError {
    fn from(e: E) -> Self {
        Self(e.into())
    }
}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = json!({"error":self.0.to_string()});
        if self.0.downcast_ref::<crate::collaboration_credentials::MessageNotSubmitted>().is_some() {
            body["code"] = "message_not_submitted".into();
        }
        (
            StatusCode::BAD_REQUEST,
            Json(body),
        )
            .into_response()
    }
}
type ApiResult<T> = Result<T, ApiError>;

/// A JSON response read and serialized on the blocking pool: records can be
/// megabytes, and neither SQLite nor their serialization belongs on an async
/// worker (see `db`).
async fn stored_json<T: serde::Serialize>(
    ws: &Workspace,
    job: impl FnOnce(&crate::store::Store) -> anyhow::Result<T> + Send + 'static,
) -> ApiResult<Response> {
    let bytes = ws.stored(move |store| Ok(serde_json::to_vec(&job(store)?)?)).await?;
    Ok(([(header::CONTENT_TYPE, "application/json")], bytes).into_response())
}

pub fn router(ws: Arc<Workspace>, assets: PathBuf) -> Router {
    router_on_port(ws, assets, 4317)
}

pub fn router_on_port(ws: Arc<Workspace>, assets: PathBuf, port: u16) -> Router {
    router_with_updates(ws, assets, port, None)
}

pub fn router_with_updates(ws: Arc<Workspace>, assets: PathBuf, port: u16, updates: Option<Arc<crate::updates::controller::Controller>>) -> Router {
    ws.start_collaboration(port);
    ws.start_jobs();
    ws.start_ci_monitor();
    ws.start_delivery();
    let mcp = crate::collaboration_mcp::router(ws.clone(), port);
    let router = browser_routes(assets, updates.clone())
        // Only on Core's own port: the desktop app on this computer asks.
        .route("/api/desktop/start-profile", get(start_profile))
        // Backups and restores start only from Core's own port (T-192).
        .merge(crate::workspace_backup::online::changes())
        // Only on Core's own port: a phone cannot change its own access.
        .merge(crate::remote_access::changes())
        .layer(middleware::from_fn_with_state(BrowserBoundary::new(), local_browser_boundary))
        .with_state(ws)
        .merge(mcp);
    finish(router, updates)
}

/// Core's entry for a phone through Tailscale Serve (T-170), on a loopback
/// port of its own that only Serve is pointed at. It serves the pages, API,
/// events and artifacts the local port serves, never the Agents' MCP
/// endpoints, and starts nothing: the local router runs Core's services.
/// Every request must pass `RemoteEntry::admit`; none falls back to the
/// local port's rules.
pub fn remote_router(ws: Arc<Workspace>, assets: PathBuf, updates: Option<Arc<crate::updates::controller::Controller>>, entry: RemoteEntry) -> Router {
    let router = browser_routes(assets, updates.clone())
        .layer(middleware::from_fn_with_state(Arc::new(entry), remote_browser_boundary))
        .with_state(ws);
    finish(router, updates)
}

fn finish(router: Router, updates: Option<Arc<crate::updates::controller::Controller>>) -> Router {
    if let Some(updates) = updates {
        router.layer(middleware::from_fn_with_state(updates.admission.clone(), update_admission))
            .layer(Extension(updates))
    } else { router }
    .layer(middleware::from_fn(run_to_completion))
}

/// The routes a browser uses: pages, API, events and artifacts.
fn browser_routes(assets: PathBuf, updates: Option<Arc<crate::updates::controller::Controller>>) -> Router<Arc<Workspace>> {
    let update_routes = updates.as_ref().map(|controller| crate::updates::api::router(controller.clone())).unwrap_or_else(Router::new);
    let asset_updates = updates;
    let asset_service = tower::service_fn(move |request: Request| crate::updates::assets::serve(assets.clone(), asset_updates.clone(), request));
    Router::new()
        .merge(update_routes)
        .merge(crate::pr_review::router())
        .merge(crate::pr_operations::router())
        .merge(crate::jobs::router())
        .merge(crate::remote_access::router())
        .merge(crate::ci_monitor::router())
        .merge(crate::claude_mcp::router())
        .merge(crate::claude_commands::router())
        .merge(crate::codex_skills::router())
        .merge(crate::codex_goal::router())
        .merge(crate::codex_mcp::router())
        .merge(crate::codex_diff::router())
        .merge(crate::codex_terminals::router())
        .merge(crate::codex_plan::router())
        .merge(crate::claude_sessions::router())
        .merge(crate::reading_handoff::router())
        .merge(crate::claude_checkpoints::router())
        .merge(crate::rewind::router())
        .merge(crate::claude_quota::router())
        .merge(crate::task_proposals::router())
        .merge(crate::task_workspaces::router())
        .merge(crate::codex_usage::router())
        .merge(crate::project_brief::router())
        .merge(crate::machine_load::router())
        .merge(crate::storage_overview::router())
        .merge(crate::github::router())
        .merge(crate::workspace_backup::online::router())
        .route("/api/health",get(health))
        .route("/api/workspace",get(workspace))
        .route("/api/backlog",get(backlog))
        .route("/api/machines",get(machines).post(add_machine))
        .route("/api/machines/{id}",axum::routing::put(update_machine).delete(remove_machine))
        .route("/api/machines/{id}/check",post(check_machine))
        .route("/api/projects",get(projects).post(create_project))
        .route("/api/projects/{id}",patch(update_project).delete(delete_project))
        .route("/api/projects/{id}/services",get(project_services).post(register_service))
        .route("/api/services/{id}",axum::routing::delete(delete_service))
        .route("/api/services/{id}/open",post(open_service))
        .route("/api/services/{id}/close",post(close_service))
        .route("/api/agents/{id}/project",post(set_agent_project))
        .route("/api/codex/sessions/preview",post(preview_session))
        .route("/api/codex/sessions/import",post(import_session))
        .route("/api/agents/{id}/history",get(session_history))
        .route("/api/agents/{id}/subagents/{thread_id}",get(codex_subagent))
        .route("/api/agents/{id}/codex/fork/preview",post(preview_fork))
        .route("/api/agents/{id}/codex/fork",post(fork_session))
        .route("/api/agents",post(create))
        .route("/api/agents/{id}",get(detail).delete(delete_agent))
        .route("/api/agents/{id}/items/{item_id}/payload",get(item_payload))
        .route("/api/agents/{id}/items/{item_id}/original",get(item_original))
        .route("/api/agents/{id}/turns/{turn_id}/original",get(turn_original))
        .route("/api/agents/{id}/conversation/search",get(conversation_search))
        .route("/api/agents/{id}/turns/{turn_id}/payload",get(turn_payload))
        .route("/api/agents/{id}/results/{result_id}",get(interactive_result))
        .route("/api/agents/{id}/close",post(close_agent))
        .route("/api/agents/{id}/reopen",post(reopen_agent))
        .route("/api/agents/{id}/turns",post(send))
        .route("/api/agents/{id}/messages",post(send_message))
        .route("/api/agents/{id}/images",post(crate::input_images::upload_route))
        .route("/api/agents/{id}/images/{image_id}",get(crate::input_images::read_route))
        .route("/api/agents/{id}/settings",post(settings))
        .route("/api/agents/{id}/context/apply",post(apply_codex_context))
        .route("/api/agents/{id}/models",get(agent_models))
        .route("/api/agents/{id}/interrupt",post(interrupt))
        .route("/api/agents/{id}/compact",post(compact))
        .route("/api/agents/{id}/codex/review",post(codex_review))
        .route("/api/agents/{id}/tasks/{task_id}/stop",post(stop_task))
        .route("/api/agents/{id}/reconnect",post(reconnect))
        .route("/api/agents/{id}/review",post(review))
        .route("/api/requests/{id}/respond",post(respond))
        .route("/api/models",get(models))
        .route("/api/diagnostics/memory",get(memory_diagnostics))
        .route("/api/diagnostics/memory/history",get(memory_history))
        .route("/api/events",get(events))
        .route("/api/collaboration/{operation}",post(collaboration))
        .route("/api/artifact",get(artifact))
        .route("/api/catchup",get(catchup))
        .route("/api/catchup/summarize",post(||async {(StatusCode::NOT_IMPLEMENTED,Json(json!({"error":"按需摘要仍在实验；当前显示可追溯的原始更新，不会用样例冒充生成结果。"})))}))
        .fallback_service(asset_service)
        .layer(DefaultBodyLimit::max(128*1024))
}

async fn update_admission(State(admission): State<Arc<crate::updates::admission::Admission>>, request: Request, next: Next) -> Response {
    let path = request.uri().path();
    // Long-lived event streams close on the shutdown watch. Update control
    // and identity probes must remain available after ordinary requests seal.
    if !path.starts_with("/api/") || path == "/api/events" || path == "/api/health" || path == "/api/updates" || path.starts_with("/api/updates/") {
        return next.run(request).await;
    }
    let _permit = match admission.enter_completion() {
        Ok(permit) => permit,
        Err(error) => return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"error":error.to_string()}))).into_response(),
    };
    next.run(request).await
}

/// What the held Agents' stored history is made of (T-140), read only when
/// the user asks: row counts and stored bytes, never contents, within
/// `history_composition::BUDGET`. Not part of /api/diagnostics/memory. One
/// measurement at a time: another asked meanwhile is told so, not queued.
async fn memory_history(State(ws): State<Arc<Workspace>>) -> ApiResult<Json<Value>> {
    static MEASURING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    struct Measuring;
    impl Drop for Measuring {
        fn drop(&mut self) {
            MEASURING.store(false, std::sync::atomic::Ordering::Release);
        }
    }
    if MEASURING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Ok(Json(crate::history_composition::busy()));
    }
    let measuring = Measuring;
    // The guard goes with the read, so a client that leaves does not free it early.
    let report = tokio::task::spawn_blocking(move || {
        let _measuring = measuring;
        crate::history_composition::composition(&ws.store, crate::history_composition::BUDGET)
    }).await?;
    Ok(Json(report))
}

/// This process's memory and its heap maintenance, read only when asked
/// (T-140): counters, never record contents, and not part of /api/health.
async fn memory_diagnostics(State(ws): State<Arc<Workspace>>, updates: Option<Extension<Arc<crate::updates::controller::Controller>>>) -> ApiResult<Json<Value>> {
    // With an update controller, `update_admission` holds this request's permit.
    let own_permit = updates.is_some();
    // Off the async workers: allocator counts lock its arenas briefly. Not
    // `stored`, whose own permit would be counted as another request.
    let report = tokio::task::spawn_blocking(move || {
        crate::heap::diagnostics(&ws.store, &ws.admission, own_permit, ws.stream_ticker_started())
    }).await?;
    Ok(Json(report))
}

/// What /api/health says this is: `product` names it.
pub const PRODUCT: &str = "yuzuno";
/// `application`, what desktop apps up to 0.2.0 require verbatim before they
/// connect. Kept beside `product` while one of them may still connect: no
/// Core can see which desktops are installed (T-137).
pub const LEGACY_APPLICATION: &str = "yuzuno-next";

async fn health(State(ws): State<Arc<Workspace>>, updates: Option<Extension<Arc<crate::updates::controller::Controller>>>) -> ApiResult<Json<Value>> {
    if let Some(Extension(controller)) = updates {
        let mut status = controller.runtime_read(|runtime| runtime.health()).await?;
        status["product"] = json!(PRODUCT);
        status["application"] = json!(LEGACY_APPLICATION);
        status["workspaceId"] = json!(controller.runtime_read(|runtime| runtime.workspace_id()).await?);
        status["releaseId"] = json!(controller.running.as_ref().map(|b| b.manifest.release_id.as_str()).unwrap_or("development"));
        status["version"] = json!(controller.running.as_ref().map(|b| b.manifest.version.as_str()).unwrap_or(env!("CARGO_PKG_VERSION")));
        return Ok(Json(status));
    }
    Ok(Json(json!({"product":PRODUCT,"application":LEGACY_APPLICATION,"version":env!("CARGO_PKG_VERSION"),
        "workspaceId":ws.stored(|store| store.workspace_id()).await?})))
}

/// Where this Core is installed in WSL, which the Windows desktop app keeps
/// to start it again when it does not answer (T-171). Paths and names only;
/// it starts nothing.
async fn start_profile(updates: Option<Extension<Arc<crate::updates::controller::Controller>>>) -> ApiResult<Json<Value>> {
    let Some(Extension(controller)) = updates else {
        return Ok(Json(json!({"available":false,"reason":"notManaged"})));
    };
    #[cfg(unix)]
    {
        let workspace = controller.runtime_read(|runtime| runtime.workspace_id()).await?;
        Ok(Json(crate::updates::start::profile(controller.layout.as_ref(), controller.launch.port, &workspace)))
    }
    #[cfg(not(unix))]
    {
        let _ = controller;
        Ok(Json(json!({"available":false,"reason":"notWsl"})))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SessionPreviewInput { thread_id: String }
async fn preview_session(State(ws): State<Arc<Workspace>>, Json(input): Json<SessionPreviewInput>) -> ApiResult<Json<crate::codex_sessions::SessionPreview>> {
    Ok(Json(ws.preview_codex_session(&input.thread_id).await?))
}
async fn import_session(State(ws): State<Arc<Workspace>>, Json(input): Json<crate::codex_sessions::ImportSession>) -> ApiResult<Json<crate::model::Agent>> {
    Ok(Json(ws.import_codex_session(input).await?))
}
async fn preview_fork(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<crate::codex_sessions::ForkPreview>> {
    Ok(Json(ws.preview_codex_fork(&id).await?))
}
async fn fork_session(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<crate::codex_sessions::ForkSession>) -> ApiResult<Json<crate::codex_sessions::ForkOutcome>> {
    Ok(Json(ws.fork_codex_session(&id, input).await?))
}
#[derive(Deserialize)]
struct HistoryQuery { cursor: Option<String> }
/// One native Codex sub-agent of this Agent, read from Codex on request.
async fn codex_subagent(State(ws): State<Arc<Workspace>>, Path((id, thread_id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.codex_subagent(&id, &thread_id).await?))
}

async fn session_history(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Query(query): Query<HistoryQuery>) -> ApiResult<Json<crate::codex_sessions::HistoryPage>> {
    Ok(Json(ws.codex_session_history(&id, query.cursor.as_deref()).await?))
}

async fn collaboration(State(ws): State<Arc<Workspace>>, Path(operation): Path<String>, Json(input): Json<Value>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.collaboration_call(None, &operation, input).await?))
}

/// Each API request runs in its own task, so a client that goes away (hyper
/// then drops the request) cannot stop an operation half-way: a store write
/// that a native request must follow, a reply recorded as sent but never
/// sent, an Agent deleted while its fork sources still point at it. Store
/// work is awaited on the blocking pool, so every operation has such points.
/// The live event stream and static files are not operations.
async fn run_to_completion(req: Request, next: Next) -> Response {
    let path = req.uri().path();
    if !path.starts_with("/api/") || path == "/api/events" {
        return next.run(req).await;
    }
    match tokio::spawn(next.run(req)).await {
        Ok(response) => response,
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error":format!("请求处理失败：{error}")})))
            .into_response(),
    }
}

// A personal, loopback-only service. No permissive CORS, and no ambient browser
// authority for mutations. Host validation also closes DNS rebinding paths:
// only a loopback name is accepted, never a domain an attacker could point
// here. Its port may differ from Core's: a browser on another computer reaches
// Core through an SSH tunnel's own local port. A page's Origin must then be
// that same host and port, so another local site cannot act as this one.
#[derive(Clone)]
struct BrowserBoundary {
    /// The Vite development server, which proxies to Core.
    dev_origins: [String; 2],
}

impl BrowserBoundary {
    fn new() -> Self {
        Self {
            dev_origins: ["http://127.0.0.1:5173".into(), "http://localhost:5173".into()],
        }
    }

    /// `127.0.0.1`, `localhost` or `[::1]`, with an optional port.
    fn loopback_host(host: &str) -> bool {
        let (name, rest) = match host.strip_prefix('[') {
            Some(inner) => match inner.split_once(']') {
                Some(parts) => parts,
                None => return false,
            },
            None => host.find(':').map_or((host, ""), |i| (&host[..i], &host[i..])),
        };
        let port_ok = match rest.strip_prefix(':') {
            Some(port) => {
                !port.is_empty()
                    && port.bytes().all(|b| b.is_ascii_digit())
                    && port.parse::<u16>().is_ok_and(|p| p != 0)
            }
            None => rest.is_empty(),
        };
        matches!(name, "127.0.0.1" | "localhost" | "::1") && port_ok
    }

    fn origin_allowed(&self, host: &str, origin: &str) -> bool {
        origin == format!("http://{host}") || self.dev_origins.iter().any(|o| o == origin)
    }
}

/// Headers only a proxy adds. Tailscale Serve sets the first three (after
/// removing any a client sent) and X-Forwarded-For on every request it passes
/// on; no local client sends them. A request with one came through a proxy
/// pointed at the local port, which is the remote entry's job (T-170), so it
/// is refused even if that proxy kept a loopback Host.
const PROXY_HEADERS: [&str; 4] = ["tailscale-user-login", "tailscale-headers-info", "tailscale-funnel-request", "x-forwarded-for"];

async fn local_browser_boundary(
    State(boundary): State<BrowserBoundary>,
    req: Request,
    next: Next,
) -> Response {
    if PROXY_HEADERS.iter().any(|name| req.headers().contains_key(*name)) {
        return (StatusCode::FORBIDDEN, "Proxied request: a phone uses Core's remote entry").into_response();
    }
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !BrowserBoundary::loopback_host(host) {
        return (StatusCode::FORBIDDEN, "Unrecognized workspace host").into_response();
    }
    if let Some(origin) = req.headers().get(header::ORIGIN) {
        if !origin
            .to_str()
            .is_ok_and(|o| boundary.origin_allowed(host, o))
        {
            return (StatusCode::FORBIDDEN, "Unrecognized workspace origin").into_response();
        }
    }
    if !matches!(*req.method(), Method::GET | Method::HEAD)
        && req
            .headers()
            .get("x-yuzuno-client")
            .and_then(|v| v.to_str().ok())
            != Some("desktop")
    {
        return (StatusCode::FORBIDDEN, "Workspace client header required").into_response();
    }
    harden(next.run(req).await)
}

fn harden(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}

/// Who may use the remote entry (T-170): one Tailscale login, through one
/// origin. Tailscale Serve keeps the browser's Host, removes any identity
/// headers a client sent, and sets `Tailscale-User-Login` only for a tailnet
/// user's request: never for a tagged node or Funnel. A request without it is
/// refused. (Tailscale does not say the machine running Serve gets none: in
/// T-170's check, its own request carried its owner's login.) A shared-in
/// user from another tailnet gets their own login, so only the configured one
/// is let in.
#[derive(Clone, Debug)]
pub struct RemoteEntry {
    origin: String,
    host: String,
    login: String,
}

impl RemoteEntry {
    /// `origin` is `https://<host>[:<port>]` as the browser shows it, with
    /// nothing after the host and port; `login` is compared byte for byte.
    pub fn new(origin: &str, login: &str) -> anyhow::Result<Self> {
        use anyhow::Context;
        let url = reqwest::Url::parse(origin).context("YUZUNO_REMOTE_ORIGIN is not a URL")?;
        anyhow::ensure!(url.scheme() == "https", "YUZUNO_REMOTE_ORIGIN must be https://");
        anyhow::ensure!(
            url.username().is_empty() && url.password().is_none() && url.path() == "/"
                && url.query().is_none() && url.fragment().is_none(),
            "YUZUNO_REMOTE_ORIGIN is https://<host>[:<port>] with nothing after it"
        );
        let host = url.host_str().filter(|h| !h.is_empty()).context("YUZUNO_REMOTE_ORIGIN names no host")?;
        // The port is None for https' own 443, which a browser leaves out too.
        let authority = url.port().map_or_else(|| host.to_owned(), |port| format!("{host}:{port}"));
        anyhow::ensure!(
            !login.is_empty() && login.trim() == login && !login.chars().any(char::is_control),
            "YUZUNO_REMOTE_LOGIN is one Tailscale login, without spaces around it"
        );
        Ok(Self { origin: format!("https://{authority}"), host: authority, login: login.to_owned() })
    }

    /// From the YUZUNO_REMOTE_PORT, _ORIGIN and _LOGIN settings: all three
    /// (a port of its own, not Core's) or none, which means no remote entry.
    pub fn from_settings(port: Option<String>, origin: Option<String>, login: Option<String>, core_port: u16) -> anyhow::Result<Option<(u16, Self)>> {
        use anyhow::Context;
        match (port, origin, login) {
            (None, None, None) => Ok(None),
            (Some(port), Some(origin), Some(login)) => {
                let port = port.parse::<u16>().ok().filter(|port| *port != 0)
                    .context("YUZUNO_REMOTE_PORT is not a port number")?;
                anyhow::ensure!(port != core_port, "YUZUNO_REMOTE_PORT must differ from Core's own port");
                Ok(Some((port, Self::new(&origin, &login)?)))
            }
            _ => anyhow::bail!("YUZUNO_REMOTE_PORT, YUZUNO_REMOTE_ORIGIN and YUZUNO_REMOTE_LOGIN go together: set all three or none"),
        }
    }

    pub fn origin(&self) -> &str {
        &self.origin
    }

    pub fn login(&self) -> &str {
        &self.login
    }

    /// Whether a request may enter: the configured login, this host and, for
    /// a change, this origin and the client header. Each header counts only
    /// if it appears once; nothing else is read, X-Forwarded-* included.
    pub fn admit(&self, method: &Method, headers: &HeaderMap) -> Result<(), &'static str> {
        fn one<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
            let mut values = headers.get_all(name).iter();
            let value = values.next()?;
            if values.next().is_some() {
                return None;
            }
            value.to_str().ok()
        }
        if headers.contains_key("tailscale-funnel-request") {
            return Err("Funnel requests are not accepted");
        }
        if one(headers, "tailscale-user-login") != Some(self.login.as_str()) {
            return Err("Not the Tailscale login this workspace allows");
        }
        if one(headers, "host") != Some(self.host.as_str()) {
            return Err("Unrecognized workspace host");
        }
        let origins = headers.get_all(header::ORIGIN).iter().count();
        let origin = one(headers, "origin");
        if origins > 0 && origin != Some(self.origin.as_str()) {
            return Err("Unrecognized workspace origin");
        }
        if !matches!(*method, Method::GET | Method::HEAD) {
            if origin != Some(self.origin.as_str()) {
                return Err("A change must come from this workspace's page");
            }
            if one(headers, "x-yuzuno-client") != Some("desktop") {
                return Err("Workspace client header required");
            }
        }
        Ok(())
    }
}

async fn remote_browser_boundary(State(entry): State<Arc<RemoteEntry>>, mut req: Request, next: Next) -> Response {
    if let Err(reason) = entry.admit(req.method(), req.headers()) {
        return (StatusCode::FORBIDDEN, reason).into_response();
    }
    // Pages that change phone access read this to stay read-only here.
    req.extensions_mut().insert(crate::remote_access::RemoteRequest);
    harden(next.run(req).await)
}

/// Native events Core has received but not yet applied, per connected Agent
/// (see `backlog`). In memory; never touches the store.
async fn backlog(State(ws): State<Arc<Workspace>>) -> Json<Value> {
    Json(ws.backlog())
}

async fn workspace(State(ws): State<Arc<Workspace>>) -> ApiResult<Response> {
    let (runtime, default_cwd) = (ws.runtime.lock().await.clone(), ws.default_cwd.clone());
    stored_json(&ws, move |store| Ok(
        json!({"agents":store.agents()?,"runtime":runtime,"defaultCwd":default_cwd,
            "opencode":{"enabled":crate::opencode_agent::enabled(),"version":crate::opencode::VERSION},
            "workspace":{"id":store.workspace_id()?},"projects":store.projects()?,
            "projectUsage":store.project_usage()?}),
    )).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Create {
    name: String,
    #[serde(default)]
    goal: String,
    #[serde(default)]
    harness: Option<String>,
    cwd: String,
    #[serde(default)]
    model: String,
    #[serde(default)]
    machine_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    /// Remember this Agent's folder as the project's default on its machine.
    #[serde(default)]
    save_project_default: bool,
}

#[cfg(test)]
mod create_tests {
    use super::*;
    #[test]
    fn creation_no_longer_requires_a_purpose_but_accepts_legacy_clients() {
        let fresh: Create = serde_json::from_value(json!({"name":"Dev","cwd":"/tmp"})).unwrap();
        assert!(fresh.goal.is_empty());
        let legacy: Create = serde_json::from_value(json!({"name":"Dev","cwd":"/tmp","goal":"historical purpose"})).unwrap();
        assert_eq!(legacy.goal,"historical purpose");
    }
}
async fn create(State(ws): State<Arc<Workspace>>, Json(p): Json<Create>) -> ApiResult<Json<Value>> {
    let project = p.project_id.clone();
    let agent = match p.harness.as_deref().unwrap_or("codex") {
        "codex" => ws.create_on(p.name, p.goal, p.cwd, p.model, p.machine_id, p.project_id).await?,
        "claude" => ws.claude_create_on(p.name, p.goal, p.cwd, p.model, p.machine_id, p.project_id).await?,
        "opencode" if crate::opencode_agent::enabled() => ws.opencode_create_on(p.name, p.cwd, p.model, p.machine_id, p.project_id).await?,
        _ => return Err(anyhow::anyhow!("未知 Harness").into()),
    };
    // The Agent already exists; a failed default update must not hide it.
    let mut response = serde_json::to_value(&agent)?;
    if let (true, Some(project)) = (p.save_project_default, project) {
        let machine = agent.remote.as_ref().map_or("local", |r| r.machine.id.as_str()).to_owned();
        let cwd = agent.cwd.clone();
        match ws.stored(move |store| store.set_project_default_dir(&project, &machine, &cwd)).await {
            Ok(_) => ws.projects_changed(),
            Err(e) => response["projectDefaultError"] = e.to_string().into(),
        }
    }
    Ok(Json(response))
}
async fn projects(State(ws): State<Arc<Workspace>>) -> ApiResult<Response> {
    stored_json(&ws, |store| Ok(json!({"projects":store.projects()?}))).await
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NewProject {
    name: String,
    #[serde(default)]
    default_dirs: std::collections::BTreeMap<String, String>,
}
async fn create_project(State(ws): State<Arc<Workspace>>, Json(p): Json<NewProject>) -> ApiResult<Json<Value>> {
    let mut dirs = std::collections::BTreeMap::new();
    for (machine, folder) in p.default_dirs {
        let folder = ws.project_folder(&machine, &folder).await?;
        dirs.insert(machine, folder);
    }
    let project = ws.stored(move |store| store.create_project(&p.name, dirs)).await?;
    ws.projects_changed();
    Ok(Json(serde_json::to_value(project)?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProjectPatch {
    #[serde(default)]
    name: Option<String>,
    /// A null or empty folder removes that machine's default.
    #[serde(default)]
    default_dirs: std::collections::BTreeMap<String, Option<String>>,
    #[serde(default)]
    archived: Option<bool>,
}
async fn update_project(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(p): Json<ProjectPatch>) -> ApiResult<Json<Value>> {
    let project = id.clone();
    ws.stored(move |store| store.project(&project)).await?;
    let mut dirs = std::collections::BTreeMap::new();
    for (machine, folder) in p.default_dirs {
        let folder = match folder.filter(|f| !f.trim().is_empty()) {
            Some(folder) => Some(ws.project_folder(&machine, &folder).await?),
            None => None,
        };
        dirs.insert(machine, folder);
    }
    let change = crate::projects::ProjectChange { name: p.name, default_dirs: dirs, archived: p.archived };
    let project = ws.stored(move |store| store.update_project(&id, change)).await?;
    ws.projects_changed();
    Ok(Json(serde_json::to_value(project)?))
}
/// Project services (T-151): the user registers, opens, closes and deletes;
/// opening forwards one loopback port and checks it answers HTTP.
async fn project_services(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.project_services(&id).await?))
}
async fn register_service(State(ws): State<Arc<Workspace>>, Path(id): Path<String>,
    Json(input): Json<crate::services::NewService>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.register_service(&id, input, json!({"kind":"user"}), None).await?))
}
async fn delete_service(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    ws.delete_service(&id).await?;
    Ok(Json(json!({"deleted":true,"serviceId":id})))
}
async fn open_service(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, headers: axum::http::HeaderMap)
    -> ApiResult<Json<Value>> {
    // The browser boundary has already accepted this page's Origin, if any.
    let origin = headers.get(header::ORIGIN).and_then(|o| o.to_str().ok());
    Ok(Json(ws.open_service(&id, origin).await?))
}
async fn close_service(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.close_service(&id).await?))
}
async fn delete_project(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    // Its services' open ways end with it (services.rs).
    ws.delete_project(&id).await?;
    Ok(Json(json!({"deleted":true,"projectId":id})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AgentProject {
    project_id: Option<String>,
}
async fn set_agent_project(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(p): Json<AgentProject>) -> ApiResult<Json<Value>> {
    let agent = id.clone();
    ws.stored(move |store| store.set_agent_project(&agent, p.project_id.as_deref())).await?;
    ws.changed(&id);
    Ok(Json(serde_json::to_value(ws.detail(&id).await?.agent)?))
}
async fn machines(State(ws): State<Arc<Workspace>>) -> ApiResult<Json<Value>> {
    let (mut checks, machines) = ws.stored(|store| Ok((store.machine_checks()?, store.machines()?))).await?;
    let mut list = vec![json!({"id":"local","name":"Core host","kind":"local","defaultCwd":ws.default_cwd})];
    for machine in machines {
        let mut value = serde_json::to_value(machine)?;
        value["kind"] = "ssh".into();
        list.push(value);
    }
    // The most recent manual check, or null when this machine was never checked.
    for value in &mut list {
        let id = value["id"].as_str().unwrap_or_default().to_owned();
        value["lastCheck"] = serde_json::to_value(checks.remove(&id))?;
    }
    Ok(Json(json!({"machines":list})))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NewMachine {
    name: String,
    target: String,
    codex: String,
    default_cwd: String,
    /// The settings below are kept as they were by an edit that leaves them
    /// out, so a client that does not know one never clears it; null clears
    /// it. The machine's data root (remote::validate_root; "" is the
    /// default too).
    #[serde(default, deserialize_with = "setting")]
    data_root: Option<Option<String>>,
    #[serde(default, deserialize_with = "setting")]
    contained: Option<Option<bool>>,
    /// Jobs settings there (see RemoteMachine), which Jobs admission applies;
    /// left out they stay as a record has them, and null clears them.
    #[serde(default, deserialize_with = "setting")]
    max_jobs: Option<Option<u32>>,
    #[serde(default, deserialize_with = "setting")]
    budget: Option<Option<remote::MachineBudget>>,
    #[serde(default, deserialize_with = "setting")]
    limit_mode: Option<Option<String>>,
}
/// A setting that is present, null or left out: Some(None) for null.
fn setting<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(deserializer: D) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}
impl NewMachine {
    /// The machine these fields describe, keeping what `before` had for a
    /// setting they leave out.
    fn machine(self, id: String, before: RemoteMachine) -> RemoteMachine {
        RemoteMachine {
            id, name: self.name.trim().into(), target: self.target.trim().into(),
            codex: self.codex.trim().into(), default_cwd: self.default_cwd.trim().into(),
            data_root: self.data_root.map_or(before.data_root, |root| {
                root.map(|root| root.trim().to_owned()).filter(|root| !root.is_empty())
            }),
            contained: self.contained.map_or(before.contained, Option::unwrap_or_default),
            max_jobs: self.max_jobs.unwrap_or(before.max_jobs),
            budget: self.budget.unwrap_or(before.budget),
            limit_mode: self.limit_mode.unwrap_or(before.limit_mode),
        }
    }
}
async fn add_machine(State(ws): State<Arc<Workspace>>, Json(mut p): Json<NewMachine>) -> ApiResult<Json<Value>> {
    // A machine added from now on holds its jobs to strict limits unless the
    // request chooses: limited, or null for the record-only mode machines
    // registered before limits keep (jobs::remote LEGACY).
    if p.limit_mode.is_none() {
        p.limit_mode = Some(Some("strict".into()));
    }
    let machine = p.machine(uuid::Uuid::new_v4().to_string(), RemoteMachine::default());
    remote::validate_machine(&machine)?;
    let _work = older_cores_work(&ws, &machine)?;
    let added = machine.clone();
    ws.stored(move |store| store.add_machine(&added)).await?;
    let _ = ws.changes.send(json!({"machines":true}));
    let mut result = serde_json::to_value(machine)?;
    result["kind"] = "ssh".into();
    Ok(Json(result))
}
/// A machine setting older Cores would ignore keeps them out of the Workspace
/// (older_cores.rs), so it is new work: refused while an update drains, when
/// the release being replaced may still have to take the Workspace back.
fn older_cores_work(ws: &Workspace, machine: &RemoteMachine) -> anyhow::Result<Option<crate::updates::admission::Permit>> {
    crate::older_cores::machine_hazard(machine).map(|_| ws.admission.enter_work()).transpose()
}
/// The Core host is the machine Core runs on: listed and checked, never
/// edited or removed.
fn ssh_machine_id(id: &str) -> anyhow::Result<()> {
    if id == "local" {
        anyhow::bail!("The Core host is the machine running Core; it can't be edited or removed");
    }
    Ok(())
}
async fn update_machine(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(p): Json<NewMachine>) -> ApiResult<Json<Value>> {
    ssh_machine_id(&id)?;
    let lookup = id.clone();
    let before = ws.stored(move |store| store.machine(&lookup)).await?;
    let machine = p.machine(id, before);
    remote::validate_machine(&machine)?;
    let _work = older_cores_work(&ws, &machine)?;
    let saved = machine.clone();
    ws.stored(move |store| store.update_machine(&saved)).await?;
    let _ = ws.changes.send(json!({"machines":true}));
    let mut result = serde_json::to_value(machine)?;
    result["kind"] = "ssh".into();
    Ok(Json(result))
}
/// Refused while an open Agent works there or an unfinished Job runs there;
/// an Agent still being created on it is refused at its insert instead (see
/// Store::remove_machine and Store::insert_created).
async fn remove_machine(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    ssh_machine_id(&id)?;
    let machine = id.clone();
    ws.stored(move |store| store.remove_machine(&machine)).await?;
    let _ = ws.changes.send(json!({"machines":true}));
    Ok(Json(json!({"removed":id})))
}
/// A failed connection is a recorded result (200), not a request error.
async fn check_machine(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    let check = crate::machines::check(&ws, &id).await?;
    let _ = ws.changes.send(json!({"machines":true}));
    Ok(Json(serde_json::to_value(check)?))
}
async fn apply_codex_context(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.apply_codex_context(&id).await?))
}
#[derive(Deserialize)]
struct ReconnectQuery {
    view: Option<String>,
}

/// The whole record, as before, unless `view=summary` asks for the Agent
/// only: for a caller that reads the conversation afterwards its own way, as
/// the UI does through the windowed detail. The view is checked before
/// anything reconnects.
async fn reconnect(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Query(query): Query<ReconnectQuery>) -> ApiResult<Json<Value>> {
    match query.view.as_deref() {
        None => Ok(Json(serde_json::to_value(ws.reconnect(&id).await?)?)),
        Some("summary") => Ok(Json(json!({"agent": ws.reconnect_summary(&id).await?}))),
        Some(other) => Err(anyhow::anyhow!("Unknown reconnect view {other:?}: use view=summary, or no view for the whole record").into()),
    }
}

/// Large tool fields arrive as bounded previews; see client_view. A record
/// not held in memory is read without its payloads (see Store::client_detail).
async fn detail(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Query(mut query): Query<crate::conversation_window::Query>,
    headers: axum::http::HeaderMap,
) -> ApiResult<Response> {
    if query.view.is_none() && headers.get("x-yuzuno-conversation").is_some_and(|v| v == "window") {
        query.view = Some("window".into());
    }
    if let Err(error) = query.validate() {
        return Ok((StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response());
    }
    // Live runtime fields are snapshots. Their changes emit agent.changed;
    // reading/serializing history must not hold up native event dispatch.
    #[derive(serde::Serialize)]
    struct Detail {
        #[serde(flatten)]
        detail: crate::model::AgentDetail,
        #[serde(rename = "backgroundShells", skip_serializing_if = "Option::is_none")]
        background_shells: Option<Value>,
        #[serde(rename = "codexPlan", skip_serializing_if = "Option::is_none")]
        codex_plan: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        collaboration: Option<crate::collaboration_credentials::CollaborationStatus>,
        #[serde(skip_serializing_if = "Option::is_none")]
        conversation: Option<Value>,
    }
    let background_shells = crate::background_shells::shells(&ws, &id);
    let codex_plan = crate::codex_plan::shown(&ws, &id);
    let collaboration = ws.collaboration_status(&id).await;
    let found = ws.stored(move |store| {
        let (mut detail, conversation) = if query.view.is_some() {
            match store.client_window(&id, &query)? {
                Ok(window) => (window.detail, Some(window.conversation)),
                Err(missing) => return Ok(Err(missing)),
            }
        } else { (store.client_detail(&id)?, None) };
        crate::results::attach(&*store.db.read()?, &mut detail)?;
        Ok(Ok(serde_json::to_vec(&Detail { detail, background_shells, codex_plan, collaboration, conversation })?))
    }).await?;
    Ok(match found {
        Ok(bytes) => ([(header::CONTENT_TYPE, "application/json"), (header::VARY, "X-Yuzuno-Conversation")], bytes).into_response(),
        Err(missing) => (StatusCode::NOT_FOUND, Json(json!({"error":missing.message(),"code":missing.code()}))).into_response(),
    })
}
/// One published interactive result version; immutable once stored.
async fn interactive_result(State(ws): State<Arc<Workspace>>, Path((id, result_id)): Path<(String, String)>) -> Response {
    match ws.stored(move |store| crate::results::get(&*store.db.read()?, &id, &result_id)).await {
        Ok(Some(result)) => Json(result).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(json!({"error":"No such result","code":"result_not_found"}))).into_response(),
        Err(e) => ApiError(e).into_response(),
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PayloadQuery {
    field: Option<String>,
    turn_id: Option<String>,
}
async fn item_original(State(ws): State<Arc<Workspace>>, Path((id, item_id)): Path<(String, String)>, Query(q): Query<PayloadQuery>) -> Response {
    payload(&ws, id, q.turn_id.clone(), Some(item_id.clone()), false, move |d| crate::conversation_window::original_item(d, q.turn_id.as_deref(), &item_id)).await
}
async fn turn_original(State(ws): State<Arc<Workspace>>, Path((id, turn_id)): Path<(String, String)>) -> Response {
    payload(&ws, id, Some(turn_id.clone()), None, true, move |d| crate::conversation_window::original_turn(d, &turn_id)).await
}
#[derive(Deserialize)]
struct SearchQuery { q: String }
async fn conversation_search(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Query(query): Query<SearchQuery>) -> ApiResult<Response> {
    if query.q.len() > 256 { return Ok((StatusCode::BAD_REQUEST, Json(json!({"error":"Search is limited to 256 bytes"}))).into_response()); }
    stored_json(&ws, move |store| store.conversation_search(&id, &query.q)).await
}
/// Full values of an Item's trimmed fields, or of one named field. Reads
/// that Item's rows only, unless its record is held in memory.
async fn item_payload(State(ws): State<Arc<Workspace>>, Path((id, item_id)): Path<(String, String)>, Query(q): Query<PayloadQuery>) -> Response {
    let turn = q.turn_id.clone();
    payload(&ws, id, turn, Some(item_id.clone()), false, move |d| client_view::item_payload(d, q.turn_id.as_deref(), &item_id, q.field.as_deref())).await
}
/// Full values of every trimmed field in one Turn. Reads that Turn's rows
/// only, unless its record is held in memory.
async fn turn_payload(State(ws): State<Arc<Workspace>>, Path((id, turn_id)): Path<(String, String)>) -> Response {
    payload(&ws, id, Some(turn_id.clone()), None, false, move |d| client_view::turn_payload(d, &turn_id)).await
}
/// Unknown Agents, Turns, Items and fields are 404s with a stable code.
/// Read (the Turn's or the Item's rows only, unless the record is held) and
/// serialized on the blocking pool, like the detail.
async fn payload(
    ws: &Workspace,
    id: String,
    turn: Option<String>,
    item: Option<String>,
    turn_sources: bool,
    read: impl FnOnce(&crate::model::AgentDetail) -> Result<Value, client_view::Missing> + Send + 'static,
) -> Response {
    enum Payload { Found(Vec<u8>), Missing(&'static str, String) }
    let found = ws.stored(move |store| Ok(match store.payload_view(&id, turn.as_deref(), item.as_deref(),
        |detail| (turn_sources.then(|| detail.agent.clone()), read(detail)))? {
        Some((agent, Ok(mut value))) => {
            // The original body still needs request-time mailbox provenance.
            // Annotate only this turn, after releasing the held record's lock.
            if let Some(agent) = agent { store.annotate_peer_turn(&agent, &mut value)?; }
            Payload::Found(serde_json::to_vec(&value)?)
        }
        Some((_, Err(m))) => Payload::Missing(m.code(), m.message()),
        None => Payload::Missing("agent_not_found", "No Agent with that ID".into()),
    })).await;
    match found {
        Ok(Payload::Found(bytes)) => ([(header::CONTENT_TYPE, "application/json")], bytes).into_response(),
        Ok(Payload::Missing(code, error)) => (StatusCode::NOT_FOUND, Json(json!({"error":error,"code":code}))).into_response(),
        Err(e) => ApiError(e).into_response(),
    }
}
async fn close_agent(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(serde_json::to_value(ws.close_agent(&id).await?.agent)?))
}
async fn reopen_agent(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(serde_json::to_value(ws.reopen_agent_summary(&id).await?)?))
}
async fn delete_agent(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    ws.delete_agent(&id).await?;
    Ok(Json(json!({"deleted":true,"agentId":id})))
}
#[derive(Deserialize)]
struct Text {
    text: String,
}
async fn send(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(p): Json<Text>,
) -> ApiResult<Json<Value>> {
    Ok(Json(ws.send(&id, p.text).await?))
}
async fn interrupt(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
) -> ApiResult<Json<Value>> {
    ws.interrupt(&id).await?;
    Ok(Json(json!({})))
}

/// One of Claude's tasks, by its task id. `requested: false`: a stop sent
/// earlier still waits for the task's own end; nothing was sent again.
async fn stop_task(State(ws): State<Arc<Workspace>>, Path((id, task_id)): Path<(String, String)>) -> ApiResult<Json<Value>> {
    Ok(Json(json!({"requested": ws.claude_stop_task(&id, &task_id).await?})))
}

/// A message, with the Codex skills it invokes (`skills`) held apart from
/// the rest, which is a `MessageInput` as strict as ever. A malformed body
/// was never submitted, so the client keeps its draft.
async fn send_message(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(mut body): Json<Value>) -> ApiResult<Json<Value>> {
    let parsed = (|| -> anyhow::Result<(MessageInput, Vec<crate::model::SkillRef>)> {
        let skills = match body.as_object_mut().and_then(|b| b.remove("skills")) {
            Some(skills) => serde_json::from_value(skills).map_err(|e| anyhow::anyhow!("Invalid skills: {e}"))?,
            None => Vec::new(),
        };
        Ok((serde_json::from_value(body).map_err(|e| anyhow::anyhow!("Invalid message: {e}"))?, skills))
    })();
    let (input, skills) = parsed.map_err(crate::collaboration_credentials::MessageNotSubmitted)?;
    Ok(Json(serde_json::to_value(ws.send_message_with_skills(&id, input, skills).await?)?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SettingsInput {
    model: String,
    settings: Option<AgentSettings>,
    #[serde(default, rename = "permissionMode")]
    permission_mode: Option<String>,
    /// Claude only. Absent keeps the saved effort; null returns to default.
    #[serde(default, deserialize_with = "present")]
    effort: Option<Option<String>>,
}
/// A field that is present, even as null, is Some.
fn present<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(d).map(Some)
}
async fn settings(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<SettingsInput>) -> ApiResult<Json<Value>> {
    let harness = ws.detail(&id).await?.agent.harness;
    if harness == "opencode" {
        return Err(anyhow::anyhow!("OpenCode Agent 的模型和权限来自 OpenCode 自己的配置，这里不能修改").into());
    }
    let agent = if harness == "claude" {
        if input.settings.is_some() { return Err(anyhow::anyhow!("Claude 模型设置不接受 Codex 权限或推理参数").into()); }
        let mut detail = ws.claude_update_settings(&id, input.model, input.effort).await?;
        if let Some(mode) = input.permission_mode {
            detail = ws.claude_set_permission_mode(&id, &mode).await?;
        }
        detail.agent
    } else {
        if input.permission_mode.is_some() { return Err(anyhow::anyhow!("Claude 权限模式不适用于 Codex").into()); }
        if input.effort.is_some() { return Err(anyhow::anyhow!("Codex 推理强度通过设置传入").into()); }
        let settings = input.settings.ok_or_else(|| anyhow::anyhow!("Codex 设置缺失"))?;
        ws.update_settings(&id, input.model, settings).await?
    };
    Ok(Json(serde_json::to_value(agent)?))
}
/// The composer's `/compact` for a Codex Agent: Codex's own compaction.
async fn compact(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.codex_compact(&id).await?))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReviewInput { target: crate::model::ReviewTarget }
/// The composer's `/review` for a Codex Agent: Codex's own review.
async fn codex_review(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<ReviewInput>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.codex_review(&id, input.target).await?))
}
#[cfg(test)]
mod models_tests {
    use super::*;
    /// T-140: `/models` picks the harness's catalog from the listed Agent,
    /// and an Agent that does not exist is refused as before, without
    /// reading a whole record.
    #[tokio::test]
    async fn the_models_route_picks_the_catalog_from_the_listed_agent() {
        let temp = tempfile::tempdir().unwrap();
        let ws = Workspace::new(temp.path().into(), "/tmp".into(), "unused".into()).unwrap();
        let detail: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"models-route","name":"A",
            "cwd":"/tmp","model":"","color":"sage","harness":"opencode","status":"idle","createdAt":"","updatedAt":"",
            "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
        let catalog = match agent_models(State(ws.clone()), Path("models-route".into())).await {
            Ok(Json(catalog)) => catalog,
            Err(error) => panic!("refused: {}", error.0),
        };
        assert_eq!(catalog, crate::opencode_agent::catalog());
        let missing = agent_models(State(ws.clone()), Path("models-missing".into())).await.err().unwrap();
        assert!(missing.0.to_string().contains("Agent 不存在"), "{}", missing.0);
        assert_eq!(crate::store::detail_reads_of("models-route"), 0, "a whole record was read");
        assert_eq!(crate::store::detail_reads_of("models-missing"), 0, "a whole record was read");
    }
}
async fn agent_models(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    // The harness is the Agent's: its listed view, not its history (T-140).
    let harness = ws.listed(&id).await?.harness;
    Ok(Json(if harness == "claude" {
        ws.claude_agent_catalog(&id).await?
    } else if harness == "opencode" {
        crate::opencode_agent::catalog()
    } else {
        ws.agent_catalog(&id).await?
    }))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Review {
    through_seq: i64,
}
async fn review(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(p): Json<Review>,
) -> ApiResult<Json<Value>> {
    let agent = id.clone();
    if ws.stored(move |store| store.review(&agent, p.through_seq)).await? {
        ws.changed(&id);
    }
    Ok(Json(json!({})))
}
#[derive(Deserialize)]
struct ResponseBody {
    response: Value,
}
async fn respond(
    State(ws): State<Arc<Workspace>>,
    Path(id): Path<String>,
    Json(p): Json<ResponseBody>,
) -> ApiResult<Json<Value>> {
    ws.respond(&id, p.response).await?;
    Ok(Json(json!({})))
}
#[derive(Deserialize)]
struct ModelsQuery { harness: Option<String> }
async fn models(State(ws): State<Arc<Workspace>>, Query(query): Query<ModelsQuery>) -> ApiResult<Json<Value>> {
    match query.harness.as_deref().unwrap_or("codex") {
        "claude" => return Ok(Json(ws.claude_catalog().await?)),
        "opencode" if crate::opencode_agent::enabled() => return Ok(Json(crate::opencode_agent::catalog())),
        "codex" => {},
        _ => return Err(anyhow::anyhow!("未知 Harness").into()),
    }
    match ws.catalog().await {
        Ok(v) => Ok(Json(v)),
        Err(e) => {
            ws.set_runtime(json!({"connected":false,"error":e.to_string()})).await;
            Err(e.into())
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventsQuery {
    last_event_id: Option<String>,
}
/// Live changes (see `events` for the protocol). A reconnect resumes after
/// `Last-Event-ID`, which browsers send on their own reconnects, or after
/// `?lastEventId=` from a client that opened a new connection.
async fn events(
    State(ws): State<Arc<Workspace>>,
    headers: header::HeaderMap,
    Query(query): Query<EventsQuery>,
) -> Sse<impl futures_util::Stream<Item = Result<Event, Infallible>>> {
    let last = headers.get("last-event-id").and_then(|v| v.to_str().ok()).map(str::to_owned)
        .or(query.last_event_id);
    Sse::new(ws.changes.stream(last.as_deref()))
}
async fn catchup(State(ws): State<Arc<Workspace>>) -> ApiResult<Response> {
    stored_json(&ws, |store| store.catchup()).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactQuery {
    agent_id: String,
    path: String,
}
pub fn artifact_path(cwd: &str, path: &str) -> anyhow::Result<PathBuf> {
    let root = std::fs::canonicalize(cwd)?;
    let requested = PathBuf::from(path);
    let full = std::fs::canonicalize(if requested.is_absolute() {
        requested
    } else {
        root.join(requested)
    })?;
    anyhow::ensure!(
        full.starts_with(root),
        "文件超出此 Agent 工作目录，无法预览"
    );
    anyhow::ensure!(full.is_file(), "只能预览普通文件");
    Ok(full)
}
async fn artifact(
    State(ws): State<Arc<Workspace>>,
    Query(p): Query<ArtifactQuery>,
) -> ApiResult<Response> {
    let a = ws.detail(&p.agent_id).await?.agent;
    let (path, bytes) = if let Some(remote_agent) = &a.remote {
        (PathBuf::from(&p.path), remote::read_artifact(&remote_agent.machine, &a.cwd, &p.path).await?)
    } else {
        let path = artifact_path(&a.cwd, &p.path)?;
        // One read limit applies even when a file grows after the metadata check.
        use tokio::io::AsyncReadExt;
        let file = tokio::fs::File::open(&path).await?;
        let mut bytes = Vec::new();
        file.take(8 * 1024 * 1024 + 1).read_to_end(&mut bytes).await?;
        (path, bytes)
    };
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(anyhow::anyhow!("预览文件上限为 8 MB").into());
    }
    let mime = match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => {
            if std::str::from_utf8(&bytes).is_err() {
                return Err(anyhow::anyhow!("此二进制格式暂不支持预览").into());
            }
            "text/plain; charset=utf-8"
        }
    };
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, mime)
        .header(
            header::CONTENT_SECURITY_POLICY,
            "sandbox; default-src 'none'",
        )
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .body(Body::from(bytes))?)
}
