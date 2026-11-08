//! The routing keys' write-only routes (YN-34 S1a). They are merged inside
//! `local_browser_boundary` only (server.rs), beside the OpenCode login: on
//! Core's own port, for the user's own browser, never on the phone entry,
//! never through MCP. A request that carries an Agent's credential (any
//! Authorization header) is refused before it reaches them. No route answers
//! with a key's or the token's value: a read says only whether one is set,
//! when, and its source.
use super::{op, Provider, Secret, Store};
use crate::workspace::Workspace;
use anyhow::Context;
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Path, Request, State},
    http::{header::AUTHORIZATION, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

/// A write of a key. No Debug: it holds the value.
#[derive(Deserialize)]
#[serde(tag = "source", rename_all = "lowercase", deny_unknown_fields)]
enum KeyWrite {
    Local { provider: Provider, value: String },
    #[serde(rename = "1password")]
    OnePassword { provider: Provider, reference: String },
}

/// A write of the service account's token. No Debug.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct TokenWrite {
    value: String,
}

struct Refused(anyhow::Error);

impl<E: Into<anyhow::Error>> From<E> for Refused {
    fn from(error: E) -> Self {
        Self(error.into())
    }
}

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        // Errors here name a key's id or the file, never a value.
        (StatusCode::BAD_REQUEST, Json(json!({"error": format!("{:#}", self.0)}))).into_response()
    }
}

/// On a blocking thread: the file is read and written with std::fs.
async fn blocking<T: Send + 'static>(job: impl FnOnce() -> anyhow::Result<T> + Send + 'static) -> Result<T, Refused> {
    Ok(tokio::task::spawn_blocking(job).await.context("The routing key file task stopped")??)
}

async fn list(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, Refused> {
    let store = Store::of(&ws.data_dir);
    let (keys, token) = blocking(move || Ok((store.keys()?, store.token()?))).await?;
    Ok(Json(json!({"keys": keys, "onePasswordToken": token})))
}

/// The body as `T`. A refusal says where it broke, never serde's words: they
/// could quote a key pasted into the wrong field.
fn parsed<T: serde::de::DeserializeOwned>(body: &Bytes, what: &str) -> Result<T, Refused> {
    serde_json::from_slice(body).map_err(|error| {
        anyhow::anyhow!("The body is not {what} ({} at line {}, column {})", match error.classify() {
            serde_json::error::Category::Io | serde_json::error::Category::Eof => "it ends early",
            serde_json::error::Category::Syntax => "not JSON",
            serde_json::error::Category::Data => "a field is missing, unknown or of the wrong kind",
        }, error.line(), error.column()).into()
    })
}

async fn put_key(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, body: Bytes) -> Result<Json<Value>, Refused> {
    let write: KeyWrite = parsed(&body, "a routing key: {source, provider, value} or {source, provider, reference}")?;
    let store = Store::of(&ws.data_dir);
    let view = blocking(move || match write {
        KeyWrite::Local { provider, value } => store.put_local(&id, provider, Secret::new(value)),
        KeyWrite::OnePassword { provider, reference } => store.put_reference(&id, provider, &reference),
    })
    .await?;
    Ok(Json(json!(view)))
}

async fn remove_key(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Value>, Refused> {
    let store = Store::of(&ws.data_dir);
    let removed = blocking(move || store.remove(&id)).await?;
    Ok(Json(json!({"removed": removed})))
}

/// Whether a 1Password key's reference names a field `op` can read with the
/// token, without reading its value (op.rs).
async fn check_key(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Value>, Refused> {
    let store = Store::of(&ws.data_dir);
    let check_id = id.clone();
    let source = blocking(move || {
        super::check_id(&check_id)?;
        store.source(&check_id)
    })
    .await?;
    let reference = match source {
        None => return Err(anyhow::anyhow!("There is no routing key {id}").into()),
        Some((_, super::Source::Local(_))) => return Err(anyhow::anyhow!("A local key is checked when an executor starts with it").into()),
        Some((_, super::Source::OnePassword { reference })) => reference,
    };
    let checked = op::check(&Store::of(&ws.data_dir), &reference).await;
    Ok(Json(match checked {
        Ok(()) => json!({"ok": true}),
        Err(unavailable) => json!({"ok": false, "reason": unavailable}),
    }))
}

async fn token(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, Refused> {
    let store = Store::of(&ws.data_dir);
    let token = blocking(move || store.token()).await?;
    Ok(Json(json!({"token": token, "op": op::installed().await})))
}

async fn put_token(State(ws): State<Arc<Workspace>>, body: Bytes) -> Result<Json<Value>, Refused> {
    let write: TokenWrite = parsed(&body, "a token: {value}")?;
    let store = Store::of(&ws.data_dir);
    let view = blocking(move || store.put_token(Secret::new(write.value))).await?;
    Ok(Json(json!(view)))
}

async fn remove_token(State(ws): State<Arc<Workspace>>) -> Result<Json<Value>, Refused> {
    let store = Store::of(&ws.data_dir);
    let removed = blocking(move || store.remove_token()).await?;
    Ok(Json(json!({"removed": removed})))
}

/// An Agent's credential is not the user: any Authorization header is
/// refused, so no Agent bearer token is ever accepted here.
async fn no_agent_credential(request: Request, next: Next) -> Response {
    if request.headers().contains_key(AUTHORIZATION) {
        return (StatusCode::FORBIDDEN, Json(json!({"error": "Routing keys take no Agent credential: only the user's own browser on Core's port changes them"})))
            .into_response();
    }
    next.run(request).await
}

/// The bodies are a key or a token: small.
const BODY_LIMIT: usize = 16 * 1024;

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/routing/keys", get(list))
        .route("/api/routing/keys/{id}", put(put_key).delete(remove_key))
        .route("/api/routing/keys/{id}/check", post(check_key))
        .route("/api/routing/1password", get(token))
        .route("/api/routing/1password/token", put(put_token).delete(remove_token))
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(middleware::from_fn(no_agent_credential))
}

#[cfg(test)]
#[path = "routes_tests.rs"]
mod tests;
