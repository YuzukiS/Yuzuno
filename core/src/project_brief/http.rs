//! Home's HTTP API (acceptance/t85/spec/interfaces.md section 3). Section
//! keys may hold '/' (topic/sub): clients send them percent-encoded as one
//! path segment (encodeURIComponent), which Path decodes.
use super::{attachments, editors, home, presentation, sections};
use crate::{server::ApiError, workspace::Workspace};
use axum::{
    body::Body,
    extract::{Path, Query, State},
    http::header,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;

type ApiResult<T> = Result<T, ApiError>;

pub(super) fn routes() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/home", get(view))
        .route("/api/home/order", post(order))
        .route("/api/home/presentation", get(home_presentation).put(save_home_presentation))
        .route("/api/projects/{id}/home-editors", get(content_editors).put(save_content_editors))
        .route("/api/projects/{id}/brief/seen", post(seen))
        .route("/api/projects/{id}/brief/defer", post(defer))
        .route("/api/projects/{id}/brief/reply", post(reply))
        .route("/api/projects/{id}/brief/attachments/{section}/{name}", get(attachment))
        .route("/api/projects/{id}/brief/chart/{section}/{element}", get(chart))
        .route("/api/brief-cache/clear", post(clear))
}

impl IntoResponse for attachments::Missing {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"error":self.message,"code":self.code}))).into_response()
    }
}

async fn view(State(ws): State<Arc<Workspace>>) -> ApiResult<Response> {
    let bytes = ws.stored(|store| Ok(serde_json::to_vec(&home::build(store)?)?)).await?;
    Ok(([(header::CONTENT_TYPE, "application/json")], bytes).into_response())
}

async fn content_editors(State(ws): State<Arc<Workspace>>, Path(id): Path<String>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.stored(move |store| Ok(serde_json::to_value(editors::get(store, &id)?)?)).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EditorsInput {
    expected_version: i64,
    // With a custom deserializer omission cannot silently become null.
    #[serde(deserialize_with = "required_editor_ids")]
    editor_agent_ids: Value,
}

fn required_editor_ids<'de, D: serde::Deserializer<'de>>(de: D) -> Result<Value, D::Error> {
    Value::deserialize(de)
}

#[test]
fn editor_list_requires_an_explicit_value_including_null() {
    assert!(serde_json::from_value::<EditorsInput>(json!({"expectedVersion":0})).is_err());
    for ids in [Value::Null, json!([]), json!(["agent"])] {
        assert!(serde_json::from_value::<EditorsInput>(json!({"expectedVersion":0,"editorAgentIds":ids})).is_ok());
    }
}

async fn save_content_editors(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<EditorsInput>) -> ApiResult<Json<Value>> {
    let ids: Option<Vec<String>> = serde_json::from_value(input.editor_agent_ids)?;
    let project = id.clone();
    let saved = ws.stored(move |store| editors::save(store, &project, input.expected_version, ids)).await?;
    super::announce(&ws, Some(&id));
    Ok(Json(serde_json::to_value(saved)?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Order {
    project_ids: Vec<String>,
}

/// The user's Home presentation preference (T-175): Settings reads and
/// saves it; it has no Agent tool.
async fn home_presentation(State(ws): State<Arc<Workspace>>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.stored(|store| presentation::view(&*store.db.read()?)).await?))
}

async fn save_home_presentation(State(ws): State<Arc<Workspace>>, Json(input): Json<presentation::Presentation>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.stored(move |store| presentation::save(store, input)).await?))
}

async fn order(State(ws): State<Arc<Workspace>>, Json(input): Json<Order>) -> ApiResult<Json<Value>> {
    let order = ws.stored(move |store| home::set_order(store, &input.project_ids)).await?;
    super::announce(&ws, None);
    Ok(Json(json!({"order":order})))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SeenSection {
    key: String,
    version: i64,
}

/// `sections` is what the client displayed, with the versions it displayed;
/// `all` says that was everything it showed of the Project. Nothing is
/// marked without a version the client names.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Seen {
    #[serde(default)]
    sections: Option<Vec<SeenSection>>,
    #[serde(default)]
    #[allow(dead_code)]
    all: bool,
}

async fn seen(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<Seen>) -> ApiResult<Json<Value>> {
    let items: Vec<(String, i64)> = input
        .sections
        .ok_or_else(|| anyhow::anyhow!("sections is required: the keys and versions you displayed"))?
        .into_iter()
        .map(|section| (section.key, section.version))
        .collect();
    if items.len() > 200 {
        return Err(anyhow::anyhow!("At most 200 sections at once").into());
    }
    let project = id.clone();
    let marked = ws.stored(move |store| sections::mark_seen(store, &project, &items)).await?;
    super::announce(&ws, Some(&id));
    Ok(Json(marked))
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Defer {
    key: String,
    until: Option<String>,
}

async fn defer(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<Defer>) -> ApiResult<Json<Value>> {
    let project = id.clone();
    let deferred = ws.stored(move |store| sections::defer(store, &project, &input.key, input.until.as_deref())).await?;
    super::announce(&ws, Some(&id));
    Ok(Json(deferred))
}

async fn reply(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<home::ReplyInput>) -> ApiResult<Json<Value>> {
    Ok(Json(serde_json::to_value(home::reply(&ws, id, input).await?)?))
}

#[derive(Deserialize)]
struct Version {
    version: Option<i64>,
}

/// A snapshot as it was kept. Never rendered as a page: images, PDFs and
/// text are shown inline, anything else downloads; HTML is sent as text.
/// Range requests get the whole file (200).
async fn attachment(
    State(ws): State<Arc<Workspace>>,
    Path((id, section, name)): Path<(String, String, String)>,
    Query(query): Query<Version>,
) -> ApiResult<Response> {
    let cache = attachments::dir(&ws.data_dir);
    let file = name.clone();
    let found = ws.stored(move |store| attachments::snapshot_file(store, &cache, &id, &section, &file, query.version)).await?;
    let (path, mime) = match found {
        Ok(found) => found,
        Err(missing) => return Ok(missing.into_response()),
    };
    let bytes = tokio::fs::read(&path).await?;
    let inline = mime.starts_with("image/") || mime == "application/pdf" || mime.starts_with("text/");
    let mime = if mime.starts_with("text/") && !mime.starts_with("text/csv") { "text/plain; charset=utf-8".to_owned() } else { mime };
    let disposition = format!("{}; filename=\"{}\"", if inline { "inline" } else { "attachment" }, name);
    // As the artifact endpoint serves files (see server::artifact).
    Ok(Response::builder()
        .header(header::CONTENT_TYPE, mime.as_str())
        .header(header::CONTENT_DISPOSITION, disposition)
        .header(header::CONTENT_SECURITY_POLICY, "sandbox; default-src 'none'")
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header("Cross-Origin-Resource-Policy", "same-origin")
        .body(Body::from(bytes))?)
}

async fn chart(
    State(ws): State<Arc<Workspace>>,
    Path((id, section, element)): Path<(String, String, String)>,
    Query(query): Query<Version>,
) -> ApiResult<Response> {
    let cache = attachments::dir(&ws.data_dir);
    let found = ws.stored(move |store| attachments::chart(store, &cache, &id, &section, &element, query.version)).await?;
    Ok(match found {
        Ok(series) => Json(series).into_response(),
        Err(missing) => missing.into_response(),
    })
}

async fn clear(State(ws): State<Arc<Workspace>>) -> ApiResult<Json<Value>> {
    let cache = attachments::dir(&ws.data_dir);
    let cleared = ws.stored(move |store| attachments::clear(store, &cache)).await?;
    super::announce(&ws, None);
    Ok(Json(cleared))
}
