//! Old tabs may lazily import a hashed chunk after the service changes version.
//! Retained bundles provide those immutable /assets files until the user reloads.
use super::controller::Controller;
use axum::{
    body::Body,
    extract::Request,
    response::{IntoResponse, Response},
};
use std::{convert::Infallible, path::PathBuf, sync::Arc};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

pub async fn serve(
    assets: PathBuf,
    updates: Option<Arc<Controller>>,
    request: Request,
) -> Result<Response, Infallible> {
    let path = request.uri().path();
    if let Some(name) = path.strip_prefix("/assets/") {
        // Vite chunks are a single hashed filename. Do not search retained
        // releases for arbitrary paths or serve manifest/runtime/helper files.
        let safe = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            && !name.contains("..");
        if safe && !assets.join("assets").join(name).is_file() {
            if let Some(layout) = updates.as_ref().and_then(|c| c.layout.as_ref()) {
                if let Ok(releases) = std::fs::read_dir(layout.root.join("releases")) {
                    for entry in releases.flatten() {
                        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                            continue;
                        }
                        let old_assets = entry.path().join("web");
                        if old_assets.join("assets").join(name).is_file() {
                            return Ok(ServeDir::new(old_assets)
                                .oneshot(request)
                                .await
                                .unwrap()
                                .map(Body::new)
                                .into_response());
                        }
                    }
                }
            }
        }
        // Missing chunks must return 404, not index.html with a JavaScript MIME
        // mismatch that hides the real problem from an old client.
        return Ok(ServeDir::new(assets)
            .oneshot(request)
            .await
            .unwrap()
            .map(Body::new)
            .into_response());
    }
    Ok(ServeDir::new(&assets)
        .not_found_service(ServeFile::new(assets.join("index.html")))
        .oneshot(request)
        .await
        .unwrap()
        .map(Body::new)
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn absent_chunks_are_not_replaced_by_new_index_html() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("index.html"), "new page").unwrap();
        let request = Request::builder()
            .uri("/assets/missing.js")
            .body(Body::empty())
            .unwrap();
        let response = serve(root.path().into(), None, request).await.unwrap();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
        let request = Request::builder().uri("/").body(Body::empty()).unwrap();
        assert_eq!(
            serve(root.path().into(), None, request)
                .await
                .unwrap()
                .status(),
            axum::http::StatusCode::OK
        );
    }
}
