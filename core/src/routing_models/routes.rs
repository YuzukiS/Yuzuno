//! `GET /api/routing/models?harness=opencode` (YN-57 S2a), beside the other
//! routing routes in `server::settings_routes`: on Core's own port and on the
//! phone entry (YN-79), and refusing an Agent's credential.
use crate::workspace::Workspace;
use axum::{
    extract::{Query, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

#[derive(Deserialize)]
struct Asked {
    harness: Option<String>,
}

async fn models(State(ws): State<Arc<Workspace>>, Query(asked): Query<Asked>) -> Response {
    match asked.harness.as_deref() {
        Some("opencode") => match ws.routing_opencode_catalog().await {
            Ok(catalog) => (StatusCode::OK, Json(catalog)).into_response(),
            // OpenCode could not list them: the page says why and offers its short list.
            Err(error) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"code": "unavailable", "error": format!("{error:#}")}))).into_response(),
        },
        _ => (StatusCode::BAD_REQUEST, Json(json!({"code": "invalid",
            "error": "Only harness=opencode is read here; Claude Code's and Codex's models are /api/models?harness=claude and /api/models"}))).into_response(),
    }
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/routing/models", get(models))
        .layer(middleware::from_fn(crate::routing_keys::routes::no_agent_credential))
}
