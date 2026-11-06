use super::*;
use axum::http::StatusCode;
use std::collections::BTreeMap;
use tower::ServiceExt;

async fn call(ws: &Arc<Workspace>, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = axum::http::Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request.body(body.map_or_else(axum::body::Body::empty, |b| axum::body::Body::from(b.to_string()))).unwrap();
    let response = router().with_state(ws.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

fn refused(answer: &Value, error: &str) -> bool {
    answer["error"].as_str().is_some_and(|e| e.starts_with(error))
}

/// T-34 S3a: the user keeps a Project's handover document through its
/// routes. Each save is a new version, checked against the version read,
/// kept with why; a past version stays readable. An archived Project's
/// document doesn't change; a deleted Project's goes with it.
#[tokio::test]
async fn a_handover_document_is_saved_as_versions_against_the_version_read() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let p = ws.store.create_project("Lab", BTreeMap::new()).unwrap().id;
    let path = format!("/api/projects/{p}/handover");
    let (status, empty) = call(&ws, "GET", &path, None).await;
    assert_eq!((status, empty["version"].clone(), empty["markdown"].clone()), (StatusCode::OK, json!(0), json!("")));
    assert_eq!(current_in(&ws.store.db.read().unwrap(), &p).unwrap(), None, "none yet");

    let mut events = ws.changes.subscribe(None);
    let (status, first) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":0,"markdown":"# Lab\nBuild with make.","reason":"First notes"}))).await;
    assert_eq!((status, first["version"].clone()), (StatusCode::OK, json!(1)), "{first}");
    let announced: Value = serde_json::from_str(&events.try_next().expect("a save is announced").data).unwrap();
    assert_eq!((announced["handover"].clone(), announced["projectId"].clone()), (json!(true), json!(p)));
    let (_, stale) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":0,"markdown":"Overwritten"}))).await;
    assert!(refused(&stale, "version_conflict: this Project's handover changed"), "a save against a stale version is refused: {stale}");
    let (_, second) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":1,"markdown":"# Lab\nBuild with make; test with make check."}))).await;
    assert_eq!(second["version"], 2);
    assert_eq!(second["markdown"], "# Lab\nBuild with make; test with make check.");
    let history: Vec<(Value, Value, Value)> = second["history"].as_array().unwrap().iter()
        .map(|v| (v["version"].clone(), v["writtenBy"]["id"].clone(), v["reason"].clone())).collect();
    assert_eq!(history, [(json!(2), json!("user"), Value::Null), (json!(1), json!("user"), json!("First notes"))], "each version is kept with why");
    assert!(second["history"][0].get("markdown").is_none(), "the list holds no texts");
    let (_, past) = call(&ws, "GET", &format!("{path}?version=1"), None).await;
    assert_eq!(past["past"]["markdown"], "# Lab\nBuild with make.", "a past version stays readable");
    assert_eq!(current_in(&ws.store.db.read().unwrap(), &p).unwrap(), Some((2, "# Lab\nBuild with make; test with make check.".into())));

    let (_, large) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":2,"markdown":"x".repeat(MAX_BYTES + 1)}))).await;
    assert!(refused(&large, "A handover document is at most 32 KiB"), "a document over 32 KiB is refused: {large}");
    let windows = "# Lab\r\n\r\nBuild\twith make.\r\n";
    let (_, pasted) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":2,"markdown":windows}))).await;
    assert_eq!((pasted["version"].clone(), pasted["markdown"].clone()), (json!(3), json!(windows)),
        "a handover pasted from Windows, with CRLF line ends and tabs, is kept: {pasted}");
    for (markdown, at) in [("Bell \u{7}", "U+0007 at line 1, column 6"), ("ok\r\nfine\u{7f}", "U+007F at line 2, column 5")] {
        let (_, control) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":3,"markdown":markdown}))).await;
        assert!(refused(&control, "A handover document is text") && control["error"].as_str().is_some_and(|e| e.ends_with(at)),
            "a document with a control character is refused, saying where ({at}): {control}");
    }
    ws.store.update_project(&p, crate::projects::ProjectChange { name: None, key: None, default_dirs: BTreeMap::new(), archived: Some(true) }).unwrap();
    let (_, archived) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":3,"markdown":"Later"}))).await;
    assert!(refused(&archived, "project_archived:"), "an archived Project's document doesn't change: {archived}");
    ws.store.update_project(&p, crate::projects::ProjectChange { name: None, key: None, default_dirs: BTreeMap::new(), archived: Some(false) }).unwrap();
    ws.store.delete_project(&p).unwrap_or_else(|e| panic!("a deleted Project's handover goes with it: {e}"));
    let left: i64 = ws.store.db.read().unwrap().query_row("SELECT COUNT(*) FROM project_handover_versions", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0, "a deleted Project's handover goes with it");
}
