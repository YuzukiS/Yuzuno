//! `GET` and `PUT /api/routing/policy` (YN-34 S3a). They sit beside the routing
//! keys' routes inside `local_browser_boundary` (server.rs):
//! - on Core's own port only, never on the phone entry or through MCP;
//! - any Authorization header is refused, so no Agent writes the policy.
use super::{check, Known};
use crate::{routing_keys::Store as KeyStore, workspace::Workspace};
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, State},
    http::StatusCode,
    middleware,
    response::{IntoResponse, Response},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;

fn answer(status: StatusCode, body: Value) -> Response {
    (status, Json(body)).into_response()
}

fn failed(error: anyhow::Error) -> Response {
    answer(StatusCode::INTERNAL_SERVER_ERROR, json!({"code": "failed", "error": format!("{error:#}")}))
}

async fn read(State(ws): State<Arc<Workspace>>) -> Response {
    match ws.stored(|store| store.routing_policy()).await {
        Ok(stored) => answer(StatusCode::OK, stored.view()),
        Err(error) => failed(error),
    }
}

async fn write(State(ws): State<Arc<Workspace>>, body: Bytes) -> Response {
    let invalid = |path: &str, error: &str| answer(StatusCode::BAD_REQUEST, json!({"code": "invalid", "error": error, "path": path}));
    let Ok(body) = serde_json::from_slice::<Value>(&body) else { return invalid("", "The body is {expectedVersion, policy}") };
    let (Some(expected), Some(policy)) = (body["expectedVersion"].as_i64(), body.get("policy").cloned()) else {
        return invalid("", "The body is {expectedVersion, policy}");
    };
    if body.as_object().is_some_and(|m| m.keys().any(|k| k != "expectedVersion" && k != "policy")) {
        return invalid("", "The body is {expectedVersion, policy}");
    }
    let dir = ws.data_dir.clone();
    let keys = match tokio::task::spawn_blocking(move || KeyStore::of(&dir).keys()).await {
        Ok(Ok(keys)) => keys.into_iter().map(|k| (k.id, k.provider)).collect(),
        Ok(Err(error)) => return answer(StatusCode::BAD_REQUEST, json!({"code": "keys_unreadable",
            "error": format!("The routing keys cannot be read, so the policy is not saved: {error:#}"), "path": ""})),
        Err(error) => return failed(error.into()),
    };
    let codex_homes = match ws.stored(|store| store.codex_homes()).await {
        Ok(homes) => homes.into_iter().map(|h| h.id).collect(),
        Err(error) => return failed(error),
    };
    if let Err(refused) = check(&policy, &Known { keys, codex_homes }) {
        return invalid(&refused.path, &refused.error);
    }
    match ws.stored(move |store| store.save_routing_policy(expected, policy)).await {
        Ok(Ok(saved)) => answer(StatusCode::OK, saved.view()),
        Ok(Err(current)) => answer(StatusCode::CONFLICT, json!({"code": "version_conflict",
            "error": "version_conflict: the routing policy changed after you read it; review it and save again",
            "current": {"version": current.version, "policy": current.policy, "updatedAt": current.updated_at}})),
        Err(error) => failed(error),
    }
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/routing/policy", get(read).put(write))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn(crate::routing_keys::routes::no_agent_credential))
}
