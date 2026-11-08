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

/// The policy a preview evaluates: a draft from the body, checked as a save is, else the saved one.
async fn draft(ws: &Arc<Workspace>, body: &Value) -> Result<(i64, Value), Response> {
    let invalid = |path: &str, error: &str| answer(StatusCode::BAD_REQUEST, json!({"code": "invalid", "error": error, "path": path}));
    match body.get("policy") {
        Some(policy) if !policy.is_null() => {
            let dir = ws.data_dir.clone();
            let keys = match tokio::task::spawn_blocking(move || KeyStore::of(&dir).keys()).await {
                Ok(Ok(keys)) => keys.into_iter().map(|k| (k.id, k.provider)).collect(),
                Ok(Err(error)) => return Err(invalid("", &format!("The routing keys cannot be read: {error:#}"))),
                Err(error) => return Err(failed(error.into())),
            };
            let codex_homes = ws.stored(|store| store.codex_homes()).await.map_err(failed)?.into_iter().map(|h| h.id).collect();
            check(policy, &Known { keys, codex_homes }).map_err(|r| invalid(&r.path, &r.error))?;
            Ok((-1, policy.clone()))
        }
        _ => ws.stored(|store| store.routing_policy()).await.map(|p| (p.version, p.policy)).map_err(failed),
    }
}

fn time(body: &Value, field: &str) -> Result<Option<chrono::DateTime<chrono::Utc>>, Response> {
    match body.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v.as_str().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|t| Some(t.with_timezone(&chrono::Utc)))
            .ok_or_else(|| answer(StatusCode::BAD_REQUEST, json!({"code": "invalid", "error": format!("{field} is an RFC 3339 time"), "path": field}))),
    }
}

/// `POST /api/routing/evaluate {policy?, at?, assume?}`: what routing would choose, from Core's own evaluator.
async fn evaluate(State(ws): State<Arc<Workspace>>, body: Bytes) -> Response {
    let Ok(body) = serde_json::from_slice::<Value>(&body) else { return answer(StatusCode::BAD_REQUEST, json!({"code": "invalid", "error": "The body is JSON", "path": ""})) };
    let (version, policy) = match draft(&ws, &body).await { Ok(p) => p, Err(r) => return r };
    let now = match time(&body, "at") { Ok(t) => t.unwrap_or_else(chrono::Utc::now), Err(r) => return r };
    let gathered = match ws.routing_gathered().await { Ok(g) => g, Err(e) => return failed(e) };
    let assume = super::evaluate::Assume::from_json(&body["assume"]);
    let route = super::evaluate::evaluate(version, &policy, "preview", &gathered.inputs(now, None, &[], None, &assume));
    answer(StatusCode::OK, route.record)
}

/// `POST /api/routing/simulate {policy?, from, to, stepMinutes, assume?}`: what would be chosen across a time
/// span, with the readings as they are now; consecutive steps with the same choice are one segment.
async fn simulate(State(ws): State<Arc<Workspace>>, body: Bytes) -> Response {
    let invalid = |path: &str, error: &str| answer(StatusCode::BAD_REQUEST, json!({"code": "invalid", "error": error, "path": path}));
    let Ok(body) = serde_json::from_slice::<Value>(&body) else { return invalid("", "The body is JSON") };
    let (version, policy) = match draft(&ws, &body).await { Ok(p) => p, Err(r) => return r };
    let (from, to) = match (time(&body, "from"), time(&body, "to")) {
        (Ok(Some(from)), Ok(Some(to))) if from < to => (from, to),
        (Err(r), _) | (_, Err(r)) => return r,
        _ => return invalid("from", "from and to are times, from before to"),
    };
    let step = match body["stepMinutes"].as_i64() {
        Some(n) if (5..=1440).contains(&n) => chrono::Duration::minutes(n),
        _ => return invalid("stepMinutes", "stepMinutes is 5 to 1440"),
    };
    if (to - from).num_minutes() / step.num_minutes() > 2016 {
        return invalid("to", "At most 2016 steps");
    }
    let gathered = match ws.routing_gathered().await { Ok(g) => g, Err(e) => return failed(e) };
    let assume = super::evaluate::Assume::from_json(&body["assume"]);
    let mut segments: Vec<Value> = Vec::new();
    let mut at = from;
    while at < to {
        let chosen = super::evaluate::evaluate(version, &policy, "preview", &gathered.inputs(at, None, &[], None, &assume)).record["chosen"].clone();
        let end = (at + step).min(to);
        match segments.last_mut() {
            Some(last) if last["chosen"] == chosen => last["to"] = end.to_rfc3339().into(),
            _ => segments.push(json!({"from": at.to_rfc3339(), "to": end.to_rfc3339(), "chosen": chosen})),
        }
        at = end;
    }
    answer(StatusCode::OK, json!({"segments": segments}))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/routing/policy", get(read).put(write))
        .route("/api/routing/evaluate", axum::routing::post(evaluate))
        .route("/api/routing/simulate", axum::routing::post(simulate))
        .layer(DefaultBodyLimit::max(256 * 1024))
        .layer(middleware::from_fn(crate::routing_keys::routes::no_agent_credential))
}
