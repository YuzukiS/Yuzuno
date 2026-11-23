//! Old tabs may lazily import a hashed chunk after the service changes version.
//! Retained bundles provide those immutable /assets files until the user reloads.
//!
//! What a browser may keep (YN-221 S6): a /assets file its build lists as
//! fingerprinted (IMMUTABLE_LIST) a year, unchanged (`immutable`, RFC 8246); another
//! /assets file only after asking again (`no-cache`); everything else,
//! index.html, the page for any other path, a missing asset and every API
//! answer, nothing (`server::harden`'s `no-store`). A /assets file the build
//! compressed (`<name>.br`, web/vite.config.ts) goes out compressed to a
//! browser that accepts br, with `Vary: Accept-Encoding`.
use super::controller::Controller;
use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
};
use std::{convert::Infallible, path::PathBuf, sync::Arc};
use tower::ServiceExt;
use tower_http::services::{ServeDir, ServeFile};

/// A response's Cache-Control, set by `serve` for `server::harden`, which
/// answers no-store for any response without one.
#[derive(Clone, Debug)]
pub struct StaticCache(pub HeaderValue);

/// One year, the longest freshness RFC 9111 §5.2.2.1 advises a server to
/// send; with `immutable` (RFC 8246) a browser does not ask again on reload.
const HASHED: &str = "public, max-age=31536000, immutable";
/// Kept, but asked again before each use.
const UNHASHED: &str = "no-cache";

/// The list of the build's fingerprinted files (`web/vite.config.ts`
/// `yuzuno-precompress`): `immutable-assets.json` at the root of a built UI,
/// `{"schema":1,"files":[…]}`, the names of the files Vite emitted into
/// /assets under its `[name]-[hash]` naming. Only a file it names is kept a
/// year; a file the list does not name (one with a fixed name, a `.br` asked
/// for by its own name, any file of a build from before the list) is asked
/// again (`no-cache`).
pub const IMMUTABLE_LIST: &str = "immutable-assets.json";

/// Whether the built UI at `root` lists `name` as fingerprinted. The list is
/// read again when its file changes (a new bundle in the same folder).
fn fingerprinted(root: &std::path::Path, name: &str) -> bool {
    type Lists = std::sync::Mutex<std::collections::HashMap<PathBuf, (Option<std::time::SystemTime>, std::collections::HashSet<String>)>>;
    static LISTS: std::sync::OnceLock<Lists> = std::sync::OnceLock::new();
    let path = root.join(IMMUTABLE_LIST);
    let modified = std::fs::metadata(&path).and_then(|m| m.modified()).ok();
    let mut lists = LISTS.get_or_init(Default::default).lock().unwrap();
    let fresh = lists.get(&path).is_some_and(|(seen, _)| *seen == modified);
    if !fresh {
        let files = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
            .filter(|list| list["schema"] == 1)
            .and_then(|list| list["files"].as_array().map(|files| files.iter().filter_map(|f| f.as_str().map(str::to_owned)).collect()))
            .unwrap_or_default();
        lists.insert(path.clone(), (modified, files));
    }
    lists[&path].1.contains(name)
}

/// A /assets file as found: kept for a year when its build lists it as
/// fingerprinted, else asked again; a miss or an error keeps harden's no-store.
fn cached(root: &std::path::Path, name: &str, mut response: Response) -> Response {
    let status = response.status();
    if !(status == StatusCode::OK || status == StatusCode::PARTIAL_CONTENT || status == StatusCode::NOT_MODIFIED) {
        return response;
    }
    let policy = if fingerprinted(root, name) { HASHED } else { UNHASHED };
    response.extensions_mut().insert(StaticCache(HeaderValue::from_static(policy)));
    // The same URL may be answered br or not (precompressed_br).
    if !response.headers().contains_key(header::VARY) {
        response.headers_mut().insert(header::VARY, HeaderValue::from_static("accept-encoding"));
    }
    response
}

/// A /assets file from `dir`, as the build wrote it or compressed.
async fn asset(dir: PathBuf, name: &str, request: Request) -> Response {
    let response = ServeDir::new(&dir).precompressed_br().oneshot(request).await.unwrap().map(Body::new).into_response();
    cached(&dir, name, response)
}

pub async fn serve(
    assets: PathBuf,
    updates: Option<Arc<Controller>>,
    request: Request,
) -> Result<Response, Infallible> {
    let root = updates.as_ref().and_then(|c| c.layout.as_ref()).map(|layout| layout.root.clone());
    Ok(serve_from(assets, root, request).await)
}

/// `serve`, with the update layout's root whose `releases` it searches for
/// a chunk this bundle does not have.
async fn serve_from(assets: PathBuf, root: Option<PathBuf>, request: Request) -> Response {
    let path = request.uri().path();
    if let Some(name) = path.strip_prefix("/assets/") {
        let name = name.to_owned();
        // Vite chunks are a single hashed filename. Do not search retained
        // releases for arbitrary paths or serve manifest/runtime/helper files.
        let safe = !name.is_empty()
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            && !name.contains("..");
        if safe && !assets.join("assets").join(&name).is_file() {
            if let Some(root) = &root {
                if let Ok(releases) = std::fs::read_dir(root.join("releases")) {
                    for entry in releases.flatten() {
                        if !entry.file_type().is_ok_and(|kind| kind.is_dir()) {
                            continue;
                        }
                        let old_assets = entry.path().join("web");
                        if old_assets.join("assets").join(&name).is_file() {
                            return asset(old_assets, &name, request).await;
                        }
                    }
                }
            }
        }
        // Missing chunks must return 404, not index.html with a JavaScript MIME
        // mismatch that hides the real problem from an old client.
        return asset(assets, &name, request).await;
    }
    ServeDir::new(&assets)
        .not_found_service(ServeFile::new(assets.join("index.html")))
        .oneshot(request)
        .await
        .unwrap()
        .map(Body::new)
        .into_response()
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

    /// The Home Screen files the web build puts at the root (T-170) go out
    /// with their own types. A missing one is answered 404 with the page's
    /// HTML, like any other unknown path outside /assets/ (the not-found
    /// service keeps the status), so it can't pass for a manifest or an icon.
    #[tokio::test]
    async fn home_screen_files_have_their_types_and_a_missing_one_is_not_found() {
        let root = tempfile::tempdir().unwrap();
        std::fs::write(root.path().join("index.html"), "<!doctype html>page").unwrap();
        std::fs::write(root.path().join("manifest.webmanifest"), "{}").unwrap();
        std::fs::write(root.path().join("apple-touch-icon.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        for (path, status, kind) in [
            ("/manifest.webmanifest", axum::http::StatusCode::OK, "application/manifest+json"),
            ("/apple-touch-icon.png", axum::http::StatusCode::OK, "image/png"),
            ("/missing.webmanifest", axum::http::StatusCode::NOT_FOUND, "text/html"),
        ] {
            let request = Request::builder().uri(path).body(Body::empty()).unwrap();
            let response = serve(root.path().into(), None, request).await.unwrap();
            assert_eq!(response.status(), status, "{path}");
            let got = response.headers()[axum::http::header::CONTENT_TYPE].to_str().unwrap();
            assert!(got.starts_with(kind), "{path}: {got}");
        }
    }

    /// A built UI: index.html, a hashed chunk with its .br, a hashed
    /// stylesheet without one, and a file in /assets without a hash.
    fn built(root: &std::path::Path) {
        std::fs::create_dir_all(root.join("assets")).unwrap();
        std::fs::write(root.join("index.html"), "<!doctype html>page").unwrap();
        std::fs::write(root.join("assets/index-BtvMAyW4.js"), "console.log('plain');").unwrap();
        std::fs::write(root.join("assets/index-BtvMAyW4.js.br"), b"\x0bcompressed").unwrap();
        std::fs::write(root.join("assets/index-B-tv_y12.css"), "body{}").unwrap();
        std::fs::write(root.join("assets/notes.txt"), "no hash").unwrap();
        // A fixed name that looks fingerprinted, not in the build's list.
        std::fs::write(root.join("assets/third-party-notices.js"), "notices").unwrap();
        std::fs::write(root.join(IMMUTABLE_LIST), r#"{"schema":1,"files":["index-BtvMAyW4.js","index-B-tv_y12.css"]}"#).unwrap();
    }

    async fn ask(root: &std::path::Path, retained: Option<PathBuf>, method: &str, path: &str, encoding: Option<&str>) -> Response {
        let mut request = Request::builder().method(method).uri(path);
        if let Some(encoding) = encoding {
            request = request.header(header::ACCEPT_ENCODING, encoding);
        }
        serve_from(root.into(), retained, request.body(Body::empty()).unwrap()).await
    }

    fn kept(response: &Response) -> Option<&str> {
        response.extensions().get::<StaticCache>().map(|kept| kept.0.to_str().unwrap())
    }

    async fn bytes(response: Response) -> Vec<u8> {
        axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap().to_vec()
    }

    #[tokio::test]
    async fn a_hashed_chunk_is_kept_a_year_and_sent_compressed_only_to_a_browser_that_takes_br() {
        let root = tempfile::tempdir().unwrap();
        built(root.path());
        let path = "/assets/index-BtvMAyW4.js";
        let response = ask(root.path(), None, "GET", path, Some("gzip, deflate, br")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(kept(&response), Some(HASHED));
        assert_eq!(response.headers()[header::VARY], "accept-encoding");
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "br");
        assert!(response.headers()[header::CONTENT_TYPE].to_str().unwrap().contains("javascript"), "{:?}", response.headers());
        assert_eq!(bytes(response).await, b"\x0bcompressed");
        // Refused (q=0), not offered, or only gzip: the file as built.
        for encoding in [Some("br;q=0, gzip"), Some("gzip"), None] {
            let response = ask(root.path(), None, "GET", path, encoding).await;
            assert_eq!((response.status(), kept(&response)), (StatusCode::OK, Some(HASHED)), "{encoding:?}");
            assert!(response.headers().get(header::CONTENT_ENCODING).is_none(), "{encoding:?}");
            assert_eq!(response.headers()[header::VARY], "accept-encoding", "{encoding:?}");
            assert_eq!(bytes(response).await, b"console.log('plain');", "{encoding:?}");
        }
        // HEAD: the same headers, no body.
        let response = ask(root.path(), None, "HEAD", path, Some("br")).await;
        assert_eq!((response.status(), kept(&response)), (StatusCode::OK, Some(HASHED)));
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "br");
        assert!(bytes(response).await.is_empty());
        // A hashed file with no .br, and one revalidated: kept a year.
        let response = ask(root.path(), None, "GET", "/assets/index-B-tv_y12.css", Some("br")).await;
        assert_eq!((response.status(), kept(&response)), (StatusCode::OK, Some(HASHED)));
        assert!(response.headers()[header::CONTENT_TYPE].to_str().unwrap().starts_with("text/css"));
        assert!(response.headers().get(header::CONTENT_ENCODING).is_none());
        let modified = response.headers()[header::LAST_MODIFIED].clone();
        let request = Request::builder().uri("/assets/index-B-tv_y12.css").header(header::IF_MODIFIED_SINCE, modified).body(Body::empty()).unwrap();
        let response = serve_from(root.path().into(), None, request).await;
        assert_eq!((response.status(), kept(&response)), (StatusCode::NOT_MODIFIED, Some(HASHED)));
    }

    #[tokio::test]
    async fn the_page_its_fallback_and_a_missing_asset_are_never_kept_and_an_unhashed_asset_is_asked_again() {
        let root = tempfile::tempdir().unwrap();
        built(root.path());
        // The page for any other path keeps the not-found status (see above).
        for (path, status) in [("/", StatusCode::OK), ("/index.html", StatusCode::OK), ("/projects/p1", StatusCode::NOT_FOUND),
            ("/assets/missing-AbCdEfGh.js", StatusCode::NOT_FOUND), ("/assets/../index.html", StatusCode::NOT_FOUND)] {
            let response = ask(root.path(), None, "GET", path, Some("br")).await;
            assert_eq!((response.status(), kept(&response)), (status, None), "{path}");
        }
        let response = ask(root.path(), None, "GET", "/assets/notes.txt", None).await;
        assert_eq!((response.status(), kept(&response)), (StatusCode::OK, Some(UNHASHED)));
        // A whole GET of a fixed name its build does not list: asked again, never kept a year.
        let response = ask(root.path(), None, "GET", "/assets/third-party-notices.js", Some("br")).await;
        assert_eq!((response.status(), kept(&response)), (StatusCode::OK, Some(UNHASHED)));
        assert_eq!(bytes(response).await, b"notices");
        // A .br asked for by its own name is not the chunk: asked again.
        let response = ask(root.path(), None, "GET", "/assets/index-BtvMAyW4.js.br", None).await;
        assert_eq!((response.status(), kept(&response)), (StatusCode::OK, Some(UNHASHED)));
    }

    #[tokio::test]
    async fn a_chunk_from_a_retained_release_is_kept_a_year_too() {
        let (root, layout) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        built(root.path());
        let old = layout.path().join("releases/core.37/web/assets");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("Old-AbCdEfGh.js"), "old chunk").unwrap();
        std::fs::write(old.join("Old-AbCdEfGh.js.br"), "old compressed").unwrap();
        std::fs::write(old.join("Unlisted-AbCdEfGh.js"), "older build").unwrap();
        std::fs::write(layout.path().join("releases/core.37/web").join(IMMUTABLE_LIST), r#"{"schema":1,"files":["Old-AbCdEfGh.js"]}"#).unwrap();
        let response = ask(root.path(), Some(layout.path().into()), "GET", "/assets/Old-AbCdEfGh.js", Some("br")).await;
        assert_eq!((response.status(), kept(&response)), (StatusCode::OK, Some(HASHED)));
        assert_eq!(response.headers()[header::CONTENT_ENCODING], "br");
        assert_eq!(bytes(response).await, b"old compressed");
        // Its own release's list decides; one it doesn't name is still read, asked again.
        let response = ask(root.path(), Some(layout.path().into()), "GET", "/assets/Unlisted-AbCdEfGh.js", None).await;
        assert_eq!((response.status(), kept(&response)), (StatusCode::OK, Some(UNHASHED)));
        assert_eq!(bytes(response).await, b"older build");
        let response = ask(root.path(), Some(layout.path().into()), "GET", "/assets/Gone-AbCdEfGh.js", None).await;
        assert_eq!((response.status(), kept(&response)), (StatusCode::NOT_FOUND, None));
    }
}
