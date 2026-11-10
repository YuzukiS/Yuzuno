use super::*;
use tower::ServiceExt;

/// The browser's receipt for `key` as Home shows it now: its Workspace,
/// identity and version, which a test changes to refuse.
fn shown(ws: &Workspace, project: &str, key: &str) -> sections::Opened {
    let row = sections::live_key(&ws.store.db.read().unwrap(), project, key).unwrap().expect("a live section");
    sections::Opened { workspace_id: ws.store.workspace_id().unwrap(), section_id: row.identity, key: key.into(), version: row.version }
}

fn open(ws: &Workspace, project: &str, opened: &sections::Opened) -> Result<Value> {
    sections::mark_opened(&ws.store, project, opened)
}

fn refusal(result: Result<Value>) -> String {
    result.err().map_or_else(|| "recorded".to_owned(), |e| format!("{e:#}"))
}

fn panel(ws: &Workspace) -> Value {
    home::build(&ws.store).unwrap()["projects"][0].clone()
}

fn home_section<'a>(panel: &'a Value, key: &str) -> &'a Value {
    panel["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap_or(&Value::Null)
}

/// What a receipt must leave as it was: each section's row, the Brief's
/// version, the Seen marks, the task and Needs you.
fn untouched(ws: &Workspace, project: &str) -> Value {
    let db = ws.store.db.read().unwrap();
    let mut query = db.prepare("SELECT key,live,kind,version,data,ask_state,updated_at,history_reason FROM project_brief_sections ORDER BY seq").unwrap();
    let rows: Vec<Value> = query.query_map([], |r| Ok(json!([r.get::<_, String>(0)?, r.get::<_, bool>(1)?, r.get::<_, String>(2)?,
        r.get::<_, i64>(3)?, r.get::<_, String>(4)?, r.get::<_, Option<String>>(5)?, r.get::<_, String>(6)?, r.get::<_, Option<String>>(7)?])))
        .unwrap().collect::<rusqlite::Result<_>>().unwrap();
    let seen: i64 = db.query_row("SELECT COUNT(*) FROM project_brief_seen", [], |r| r.get(0)).unwrap();
    let task: String = db.query_row("SELECT data FROM collaboration_tasks", [], |r| r.get(0)).unwrap();
    drop(query);
    drop(db);
    let needs = home::build(&ws.store).unwrap()["needsYou"].clone();
    json!({"rows":rows,"brief":version(ws, project),"seen":seen,"task":task,"needsYou":needs})
}

/// YN-86: a browser that showed a live report whole records that very
/// version, apart from the Seen mark: the report stays live and in place,
/// it is no longer counted as changed, and nothing else changes. Its next
/// version is changed again; Seen still puts it into history.
#[tokio::test]
async fn an_opened_report_is_read_at_that_version_and_stays_live_with_nothing_else_changed() {
    let (_dir, ws, project) = lab();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Ship it","status":"doing"})).unwrap();
    accept(&ws, "a", input("a1", 0, vec![put("result", "report"), put("decide", "ask"), put("load", "status")])).await;
    assert_eq!(panel(&ws)["unseen"], 3);
    let before = untouched(&ws, &project);
    let receipt = shown(&ws, &project, "result");
    let first = open(&ws, &project, &receipt).unwrap();
    assert_eq!((first["sectionId"].clone(), first["key"].clone(), first["version"].clone(), first["recorded"].clone()),
        (json!(receipt.section_id), json!("result"), json!(1), json!(true)), "{first}");
    assert_eq!(untouched(&ws, &project), before, "no section, version, Seen mark, ask, task or Needs you changes");
    let shown_now = panel(&ws);
    assert_eq!(shown_now["unseen"], 2, "the report is read; the ask and the status are not");
    let report = home_section(&shown_now, "result");
    assert_eq!((report["opened"]["version"].clone(), report["opened"]["at"].clone(), report["seen"].clone(), report["history"].clone()),
        (json!(1), first["at"].clone(), Value::Null, json!(false)), "live, in place, opened and never marked seen: {report}");
    assert_eq!(home_section(&shown_now, "decide")["opened"], Value::Null);
    assert_eq!(section(&brief(&ws, "a"), "result")["seen"], Value::Null, "its owner still reads it as not seen");
    // The same version again records nothing new.
    let again = open(&ws, &project, &receipt).unwrap();
    assert_eq!((again["recorded"].clone(), again["at"].clone()), (json!(false), first["at"].clone()));
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_opened"), 1);
    // Its next version is changed again, and that one is opened in turn.
    accept(&ws, "a", input("a2", version(&ws, &project), vec![put("result", "report")])).await;
    let updated = panel(&ws);
    assert_eq!((updated["unseen"].clone(), home_section(&updated, "result")["opened"]["version"].clone()), (json!(3), json!(1)));
    assert!(refusal(open(&ws, &project, &receipt)).starts_with("version_changed: version 2 is live, not version 1"), "an older version records nothing");
    assert_eq!(open(&ws, &project, &shown(&ws, &project, "result")).unwrap()["version"], 2);
    assert_eq!(panel(&ws)["unseen"], 2);
    // Seen still records the version and puts the report into history, as before.
    let marked = sections::mark_seen(&ws.store, &project, &[("result".into(), 2)]).unwrap();
    assert_eq!((marked["archived"].clone(), marked["unseen"].clone()), (json!(["result"]), json!(2)));
    let after = panel(&ws);
    assert_eq!(after["brief"]["history"][0]["key"], "result");
    assert_eq!(after["brief"]["history"][0]["seen"]["version"], 2);
}

/// A receipt records only the section and version the browser showed on
/// this Workspace's Home: never another Workspace's, a key written anew, an
/// older or newer version, a section that is not a live report, or one the
/// user marked seen; and never as the version live now.
#[tokio::test]
async fn an_opened_receipt_for_another_workspace_section_or_version_records_nothing() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("result", "report"), put("decide", "ask"), put("load", "status")])).await;
    let receipt = shown(&ws, &project, "result");
    let mut other = shown(&ws, &project, "result");
    other.workspace_id = "another-workspace".into();
    assert!(refusal(open(&ws, &project, &other)).starts_with("workspace_changed:"));
    let mut future = shown(&ws, &project, "result");
    future.version = 2;
    assert!(refusal(open(&ws, &project, &future)).starts_with("version_changed: version 1 is live, not version 2"), "never clamped to the live version");
    for key in ["decide", "load"] {
        assert!(refusal(open(&ws, &project, &shown(&ws, &project, key))).starts_with("not_report:"), "{key}");
    }
    let mut missing = shown(&ws, &project, "result");
    missing.key = "nothing".into();
    assert!(refusal(open(&ws, &project, &missing)).starts_with("section_not_found:"));
    assert!(refusal(open(&ws, "no-such-project", &receipt)).contains("project"), "an unknown Project");
    // Removed and written again under its key, it is another section.
    accept(&ws, "a", input("a2", version(&ws, &project), vec![op("remove", "result")])).await;
    accept(&ws, "a", input("a3", version(&ws, &project), vec![put("result", "report")])).await;
    let anew = shown(&ws, &project, "result");
    assert_ne!(anew.section_id, receipt.section_id);
    let mut old = shown(&ws, &project, "result");
    old.section_id = receipt.section_id;
    assert!(refusal(open(&ws, &project, &old)).starts_with("section_changed:"), "the old section's receipt never reads the new one");
    // Marked seen, it is history: nothing to record.
    sections::mark_seen(&ws.store, &project, &[("result".into(), anew.version)]).unwrap();
    assert!(refusal(open(&ws, &project, &anew)).starts_with("section_not_found:"));
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_opened"), 0, "nothing was recorded");
}

/// The browser's route: the receipt's fields by name and nothing else; a
/// refusal is an error, as Seen's are.
#[tokio::test]
async fn the_opened_route_takes_the_receipt_and_refuses_unknown_fields() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("result", "report")])).await;
    let receipt = shown(&ws, &project, "result");
    let post = |body: Value| {
        let ws = ws.clone();
        let path = format!("/api/projects/{project}/brief/opened");
        async move {
            let request = axum::http::Request::builder().method("POST").uri(path).header("content-type", "application/json")
                .body(axum::body::Body::from(body.to_string())).unwrap();
            let response = super::super::router().with_state(ws).oneshot(request).await.unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
            (status, serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null))
        }
    };
    let body = json!({"workspaceId":receipt.workspace_id,"sectionId":receipt.section_id,"key":"result","version":1});
    let mut events = ws.changes.subscribe(None);
    let (status, answer) = post(body.clone()).await;
    assert_eq!((status.as_u16(), answer["version"].clone(), answer["recorded"].clone()), (200, json!(1), json!(true)), "{answer}");
    let announced: Value = serde_json::from_str(&events.try_next().expect("a receipt is announced").data).unwrap();
    assert_eq!((announced["scope"].clone(), announced["projectId"].clone()), (json!("brief"), json!(project)));
    let (status, answer) = post(body.clone()).await;
    assert_eq!((status.as_u16(), answer["recorded"].clone()), (200, json!(false)));
    assert!(events.try_next().is_none(), "the same version again is not announced");
    let mut extra = body.clone();
    extra["seen"] = json!(true);
    assert_eq!(post(extra).await.0.as_u16(), 422, "unknown fields are refused");
    let mut stale = body;
    stale["version"] = json!(2);
    let (status, answer) = post(stale).await;
    assert_eq!(status.as_u16(), 400);
    assert!(answer["error"].as_str().unwrap_or_default().starts_with("version_changed:"), "{answer}");
}
