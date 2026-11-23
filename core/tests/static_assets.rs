//! YN-221 S6: what a browser may keep, through both of Core's entries and
//! their `harden`: a hashed /assets file a year (and compressed when it takes
//! br); the page, the page for any other path, a missing asset and the API
//! nothing.
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    Router,
};
use std::sync::Arc;
use tower::ServiceExt;
use yuzuno_workspace::{
    server::{self, RemoteEntry},
    workspace::Workspace,
};

const CHUNK: &str = "/assets/index-BtvMAyW4.js";
const KEPT: &str = "public, max-age=31536000, immutable";

fn built(root: &std::path::Path) {
    std::fs::create_dir_all(root.join("assets")).unwrap();
    std::fs::write(root.join("index.html"), "<!doctype html>page").unwrap();
    std::fs::write(root.join("assets/index-BtvMAyW4.js"), "console.log('plain');").unwrap();
    std::fs::write(root.join("assets/index-BtvMAyW4.js.br"), b"\x0bcompressed").unwrap();
    std::fs::write(root.join("immutable-assets.json"), r#"{"schema":1,"files":["index-BtvMAyW4.js"]}"#).unwrap();
}

async fn get(app: &Router, path: &str, headers: &[(&str, &str)]) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let mut builder = Request::builder().method("GET").uri(path);
    for (name, value) in headers {
        builder = builder.header(*name, *value);
    }
    let response = app.clone().oneshot(builder.body(Body::empty()).unwrap()).await.unwrap();
    let (status, headers) = (response.status(), response.headers().clone());
    (status, headers, to_bytes(response.into_body(), 1 << 20).await.unwrap().to_vec())
}

async fn holds(app: &Router, entry: &[(&str, &str)]) {
    let with = |extra: &[(&'static str, &'static str)]| [entry, extra].concat();
    let (status, headers, body) = get(app, CHUNK, &with(&[("accept-encoding", "gzip, br")])).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!((headers["cache-control"].to_str().unwrap(), headers["vary"].to_str().unwrap()), (KEPT, "accept-encoding"));
    assert_eq!((headers["content-encoding"].to_str().unwrap(), headers["x-content-type-options"].to_str().unwrap()), ("br", "nosniff"));
    assert_eq!(body, b"\x0bcompressed");
    let (status, headers, body) = get(app, CHUNK, &with(&[("accept-encoding", "br;q=0")])).await;
    assert_eq!((status, headers["cache-control"].to_str().unwrap(), body.as_slice()), (StatusCode::OK, KEPT, &b"console.log('plain');"[..]));
    assert!(headers.get("content-encoding").is_none());
    // The page for another path is index.html with 404 (updates/assets.rs).
    for (path, status) in [("/", StatusCode::OK), ("/some/page", StatusCode::NOT_FOUND), ("/assets/missing-AbCdEfGh.js", StatusCode::NOT_FOUND),
        ("/api/health", StatusCode::OK)] {
        let (got, headers, _) = get(app, path, &with(&[("accept-encoding", "br"), ("x-yuzuno-client", "desktop")])).await;
        assert_eq!((got, headers["cache-control"].to_str().unwrap()), (status, "no-store"), "{path}");
    }
}

#[tokio::test]
async fn both_entries_keep_hashed_assets_and_nothing_else() {
    let tmp = tempfile::tempdir().unwrap();
    let web = tmp.path().join("web");
    built(&web);
    let ws: Arc<Workspace> = Workspace::new(tmp.path().join("data"), tmp.path().to_string_lossy().into(), "must-not-run".into()).unwrap();
    holds(&server::router(ws.clone(), web.clone()), &[("host", "127.0.0.1:4317")]).await;
    let entry = RemoteEntry::new("https://core.example-tailnet.ts.net:8444", "person@example.com").unwrap();
    let phone = server::remote_router(ws, web, None, entry);
    holds(&phone, &[("host", "core.example-tailnet.ts.net:8444"), ("tailscale-user-login", "person@example.com")]).await;
}
