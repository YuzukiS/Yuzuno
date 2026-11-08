//! `GET /api/routing/readings` (YN-34 S2a): read-only, beside the routing keys'
//! and accounts' routes inside `local_browser_boundary` (server.rs). It is on
//! Core's own port only, never on the phone entry or through MCP, and refuses
//! any Authorization header. It answers from what Core last observed and
//! starts no read itself.
use crate::workspace::Workspace;
use axum::{extract::State, http::StatusCode, middleware, response::IntoResponse, routing::get, Json, Router};
use chrono::Utc;
use serde_json::{json, Map, Value};
use std::sync::Arc;

async fn readings(State(ws): State<Arc<Workspace>>) -> impl IntoResponse {
    let at = Utc::now();
    let day = super::today();
    match ws.stored(move |store| store.spend_on(day)).await {
        Ok(spend) => {
            let schedules: Map<String, Value> = super::BUILTIN.iter()
                .filter_map(|id| super::builtin(id).map(|s| (id.to_string(), super::schedule_now(&s, at))))
                .collect();
            (StatusCode::OK, Json(json!({
                "at": at.to_rfc3339(),
                // Account quotas: S2b.
                "accounts": [],
                "spend": {
                    "day": spend.day, "timeZone": "local", "totalUsd": spend.total_usd, "byKey": spend.by_key,
                    "note": "What the harnesses report for executors on a routing key: an estimate, not a bill. Codex is not counted yet.",
                    "noteZh": "执行者用路由密钥时各工具自己报的花费：是估算，不是账单。Codex 暂不计入。",
                },
                "schedules": schedules,
            })))
        }
        Err(error) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"error": format!("{error:#}")}))),
    }
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/routing/readings", get(readings))
        .layer(middleware::from_fn(crate::routing_keys::routes::no_agent_credential))
}
