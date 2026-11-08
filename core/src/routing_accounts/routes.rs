//! Routing accounts' routes (YN-34 S1b), beside the routing keys' inside
//! `local_browser_boundary` (server.rs): on Core's own port only, never on
//! the phone entry or through MCP, and refusing any Authorization header,
//! since the cswap command they set is a program Core runs.
use super::{check_command, CodexHome, CswapSettings, CSWAP_PINNED};
use crate::workspace::Workspace;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::{get, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

struct Refused(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for Refused {
    fn from(error: E) -> Self {
        Self(error.into())
    }
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        (StatusCode::BAD_REQUEST, Json(json!({"error": format!("{:#}", self.0)}))).into_response()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct HomesWrite {
    homes: Vec<CodexHome>,
}

async fn accounts(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, Refused> {
    let (settings, listed) = ws.routing_cswap_accounts().await?;
    let homes = ws.stored(|store| store.codex_homes()).await?;
    let cswap = match listed {
        Ok(accounts) => json!({"command": settings.command, "pinned": CSWAP_PINNED, "accounts": accounts}),
        Err(why) => json!({"command": settings.command, "pinned": CSWAP_PINNED, "unavailable": why}),
    };
    Ok(Json(json!({"cswap": cswap, "codexHomes": homes})))
}

async fn put_cswap(State(ws): State<Arc<Workspace>>, body: Bytes) -> Result<Json<Value>, Refused> {
    let write: CswapSettings = serde_json::from_slice(&body).map_err(|e| anyhow::anyhow!("The body is {{\"command\": …}}: {e}"))?;
    let settings = CswapSettings { command: check_command(&write.command)? };
    let saved = settings.clone();
    ws.stored(move |store| store.save_cswap_settings(&saved)).await?;
    Ok(Json(json!(settings)))
}

async fn put_homes(State(ws): State<Arc<Workspace>>, body: Bytes) -> Result<Json<Value>, Refused> {
    let write: HomesWrite = serde_json::from_slice(&body).map_err(|e| anyhow::anyhow!("The body is {{\"homes\": [{{id, label, home}}]}}: {e}"))?;
    // Kept as checked: id, label and folder trimmed (R1 4cdc9655, P3).
    let homes: Vec<CodexHome> = write.homes.into_iter()
        .map(|h| CodexHome { id: h.id.trim().into(), label: h.label.trim().into(), home: h.home.trim().into() }).collect();
    let saved = homes.clone();
    ws.stored(move |store| store.save_codex_homes(&saved)).await?;
    Ok(Json(json!({"codexHomes": homes})))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/routing/accounts", get(accounts))
        .route("/api/routing/cswap", put(put_cswap))
        .route("/api/routing/codex-homes", put(put_homes))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(middleware::from_fn(crate::routing_keys::routes::no_agent_credential))
}
