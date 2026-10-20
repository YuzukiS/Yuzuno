use super::{controller::Controller, desktop_releases};
use axum::{
    body::{Body, Bytes},
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use tokio::io::AsyncReadExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

struct Error(anyhow::Error);
impl<E: Into<anyhow::Error>> From<E> for Error {
    fn from(error: E) -> Self {
        Self(error.into())
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (
            StatusCode::CONFLICT,
            Json(json!({"error":format!("{:#}", self.0)})),
        )
            .into_response()
    }
}
type Result<T> = std::result::Result<T, Error>;

pub fn router<S: Clone + Send + Sync + 'static>(controller: Arc<Controller>) -> Router<S> {
    Router::new()
        .route("/api/updates", get(status))
        .route("/api/updates/check", post(check))
        .route("/api/updates/download", post(download))
        .route("/api/updates/download/cancel", post(cancel_download))
        .route("/api/updates/prepare", post(prepare))
        .route("/api/updates/apply", post(apply))
        .route("/api/updates/cancel", post(cancel))
        .route("/api/updates/desktop/{target}/manifest", get(desktop_manifest))
        .route("/api/updates/desktop/{target}/installer", get(desktop_installer))
        .with_state(controller)
}

/// Read by the desktop's own updater, which treats anything but a manifest as
/// "no release here" and verifies whatever it then downloads.
async fn desktop_manifest(
    State(controller): State<Arc<Controller>>,
    Path(target): Path<String>,
    headers: HeaderMap,
) -> Response {
    let host = headers.get(header::HOST).and_then(|h| h.to_str().ok()).unwrap_or("");
    match desktop_releases::shared().manifest(&controller, &target, host).await {
        Ok(manifest) => Json(manifest).into_response(),
        Err(error) => (StatusCode::NOT_FOUND, Json(json!({"error":format!("{error:#}")}))).into_response(),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallerQuery {
    tag: String,
}
async fn desktop_installer(
    State(controller): State<Arc<Controller>>,
    Path(target): Path<String>,
    Query(query): Query<InstallerQuery>,
) -> Response {
    let opened = async {
        let (file, size) = desktop_releases::shared()
            .installer(&controller, &target, &query.tag)
            .await?;
        // Open, then let the temporary file go: nothing of it outlives this response.
        let reader = tokio::fs::File::open(file.path()).await?;
        drop(file);
        Ok::<_, anyhow::Error>((reader, size))
    }
    .await;
    let (reader, size) = match opened {
        Ok(opened) => opened,
        Err(error) => {
            return (StatusCode::NOT_FOUND, Json(json!({"error":format!("{error:#}")}))).into_response()
        }
    };
    let chunks = futures_util::stream::unfold(Some(reader), |reader| async move {
        let mut reader = reader?;
        let mut buffer = vec![0; 64 * 1024];
        match reader.read(&mut buffer).await {
            Ok(0) => None,
            Ok(n) => {
                buffer.truncate(n);
                Some((Ok::<_, std::io::Error>(Bytes::from(buffer)), Some(reader)))
            }
            Err(error) => Some((Err(error), None)),
        }
    });
    (
        [
            (header::CONTENT_TYPE, "application/octet-stream".to_owned()),
            (header::CONTENT_LENGTH, size.to_string()),
        ],
        Body::from_stream(chunks),
    )
        .into_response()
}

async fn status(State(controller): State<Arc<Controller>>) -> Result<Json<Value>> {
    Ok(Json(controller.status().await?))
}
async fn check(State(controller): State<Arc<Controller>>) -> Result<Json<Value>> {
    controller.check().await?;
    super::releases::Releases::check(&controller)?;
    Ok(Json(controller.status().await?))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReleaseInput {
    release_id: String,
}
async fn download(State(controller): State<Arc<Controller>>, Json(input): Json<ReleaseInput>) -> Result<Json<Value>> {
    super::releases::Releases::download(&controller, &input.release_id)?;
    Ok(Json(controller.status().await?))
}
async fn cancel_download(State(controller): State<Arc<Controller>>) -> Result<Json<Value>> {
    controller.releases.cancel()?;
    Ok(Json(controller.status().await?))
}
async fn prepare(
    State(controller): State<Arc<Controller>>,
    Json(input): Json<ReleaseInput>,
) -> Result<Json<Value>> {
    Ok(Json(
        json!({"operationId":controller.prepare(&input.release_id).await?}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ApplyInput {
    release_id: String,
    request_id: String,
}
async fn apply(
    State(controller): State<Arc<Controller>>,
    Json(input): Json<ApplyInput>,
) -> Result<Json<Value>> {
    Ok(Json(
        json!({"operationId":controller.apply(&input.release_id, &input.request_id).await?}),
    ))
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelInput {
    operation_id: String,
}
async fn cancel(
    State(controller): State<Arc<Controller>>,
    Json(input): Json<CancelInput>,
) -> Result<Json<Value>> {
    controller.cancel(&input.operation_id).await?;
    Ok(Json(json!({"cancelled":true})))
}
