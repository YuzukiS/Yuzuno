//! Home's HTTP API (acceptance/t85/spec/interfaces.md section 3). Section
//! keys may hold '/' (topic/sub): clients send them percent-encoded as one
//! path segment (encodeURIComponent), which Path decodes.
use super::{attachments, editors, home, presentation, refresh_writes, sections};
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
        .route("/api/projects/{id}/brief/opened", post(opened))
        .route("/api/projects/{id}/brief/defer", post(defer))
        .route("/api/projects/{id}/brief/reply", post(reply))
        .route("/api/projects/{id}/brief/attachments/{section}/{name}", get(attachment))
        .route("/api/projects/{id}/brief/chart/{section}/{element}", get(chart))
        .route("/api/projects/{id}/brief/research/{section}/{element}", get(research))
        .route("/api/brief-cache/clear", post(clear))
        .route("/api/brief-refreshes", get(refreshes))
        .route("/api/brief-refreshes/limits", get(refresh_limits).put(save_refresh_limits))
        .route("/api/projects/{id}/brief/refreshes/{identity}", axum::routing::put(change_refresh).delete(remove_refresh))
        .route("/api/projects/{id}/brief/refreshes/{identity}/now", post(refresh_now))
        .route("/api/projects/{id}/brief/refreshes/{identity}/versions", get(refresh_versions))
        .route("/api/projects/{id}/brief/refreshes/{identity}/versions/{version}", get(refresh_version))
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

/// An older page's save of the Home editors (YN-2 S4): refused, whatever it
/// sends; nothing is written.
async fn save_content_editors() -> ApiResult<Json<Value>> {
    Err(anyhow::anyhow!(editors::SETTING_REMOVED).into())
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

/// The user's browser showed a live report whole (YN-86): a receipt of
/// reading, never a Seen mark; see sections::mark_opened. Home's own route,
/// with no Agent tool.
async fn opened(State(ws): State<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<sections::Opened>) -> ApiResult<Json<Value>> {
    let project = id.clone();
    let marked = ws.stored(move |store| sections::mark_opened(store, &project, &input)).await?;
    if marked["recorded"] == true || marked["archived"] == true {
        super::announce(&ws, Some(&id));
    }
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

/// One research desk of one section version: the numbers it reads from the
/// section's JSON snapshots and what Core knows of each source's snapshot.
async fn research(
    State(ws): State<Arc<Workspace>>,
    Path((id, section, element)): Path<(String, String, String)>,
    Query(query): Query<Version>,
) -> ApiResult<Response> {
    let cache = attachments::dir(&ws.data_dir);
    let found = ws.stored(move |store| super::research::desk(store, &cache, &id, &section, &element, query.version)).await?;
    Ok(match found {
        Ok(desk) => Json(desk).into_response(),
        Err(missing) => missing.into_response(),
    })
}

/// Every card that refreshes itself, with the limits and totals (YN-113):
/// for Settings and notifications. Read-only.
async fn refreshes(State(ws): State<Arc<Workspace>>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.stored(super::refresh::list).await?))
}

/// A refused change of a refresh or its limits: its status, code and
/// message, and the refresh (or limits) as they are now when the page's copy
/// is out of date.
impl IntoResponse for refresh_writes::Refused {
    fn into_response(self) -> Response {
        let mut body = json!({"error":format!("{}: {}", self.code, self.message),"code":self.code});
        if let Some(current) = self.current {
            body["current"] = current;
        }
        (self.status, Json(body)).into_response()
    }
}

/// A user's change of a refresh: its answer; Home's pages are told, and the
/// timer looks at it now.
fn refreshed(ws: &Arc<Workspace>, project: Option<&str>, answer: Result<Value, refresh_writes::Refused>) -> Response {
    match answer {
        Ok(value) => {
            super::announce(ws, project);
            ws.brief_refresh.wake.notify_one();
            Json(value).into_response()
        }
        Err(refused) => refused.into_response(),
    }
}

/// The user's change of a card's refresh from the card or Settings (YN-113
/// §6.3): cadence, zone, instruction, on or off, against the version read.
async fn change_refresh(
    State(ws): State<Arc<Workspace>>,
    Path((id, identity)): Path<(String, i64)>,
    Json(input): Json<refresh_writes::UserChange>,
) -> ApiResult<Response> {
    let project = id.clone();
    let answer = ws.stored(move |store| refresh_writes::change(store, &project, identity, input)).await?;
    Ok(refreshed(&ws, Some(&id), answer))
}

/// Removes a card's refresh; the card stays.
async fn remove_refresh(State(ws): State<Arc<Workspace>>, Path((id, identity)): Path<(String, i64)>) -> ApiResult<Response> {
    let project = id.clone();
    let answer = ws.stored(move |store| refresh_writes::delete(store, &project, identity)).await?;
    Ok(refreshed(&ws, Some(&id), answer))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Now {
    request_id: String,
}

/// Refreshes a card once now, outside its cadence.
async fn refresh_now(State(ws): State<Arc<Workspace>>, Path((id, identity)): Path<(String, i64)>, Json(input): Json<Now>) -> ApiResult<Response> {
    let project = id.clone();
    let answer = ws.stored(move |store| refresh_writes::refresh_now(store, &project, identity, &input.request_id)).await?;
    Ok(refreshed(&ws, Some(&id), answer))
}

/// A card's issues of the last 30 days, newest first. Read-only.
async fn refresh_versions(State(ws): State<Arc<Workspace>>, Path((id, identity)): Path<(String, i64)>) -> ApiResult<Response> {
    let answer = ws.stored(move |store| refresh_writes::versions(store, &id, identity)).await?;
    Ok(answer.map_or_else(IntoResponse::into_response, |value| Json(value).into_response()))
}

/// One issue of a card, whole. Read-only.
async fn refresh_version(State(ws): State<Arc<Workspace>>, Path((id, identity, version)): Path<(String, i64, i64)>) -> ApiResult<Response> {
    let answer = ws.stored(move |store| refresh_writes::version(store, &id, identity, version)).await?;
    Ok(answer.map_or_else(IntoResponse::into_response, |value| Json(value).into_response()))
}

async fn refresh_limits(State(ws): State<Arc<Workspace>>) -> ApiResult<Json<Value>> {
    Ok(Json(ws.stored(refresh_writes::limits).await?))
}

/// The user's limits on refreshes (YN-113 §3.3), against the version read.
async fn save_refresh_limits(State(ws): State<Arc<Workspace>>, Json(input): Json<refresh_writes::LimitsInput>) -> ApiResult<Response> {
    let answer = ws.stored(move |store| refresh_writes::save_limits(store, input)).await?;
    Ok(refreshed(&ws, None, answer))
}

async fn clear(State(ws): State<Arc<Workspace>>) -> ApiResult<Json<Value>> {
    let cache = attachments::dir(&ws.data_dir);
    let cleared = ws.stored(move |store| attachments::clear(store, &cache)).await?;
    super::announce(&ws, None);
    Ok(Json(cleared))
}
