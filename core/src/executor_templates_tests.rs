use super::*;
use axum::http::StatusCode;
use std::collections::BTreeMap;
use tower::ServiceExt;

fn template(id: &str, harness: &str) -> Value {
    json!({"id": id, "label": format!("Label {id}"), "harness": harness})
}

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

fn ids(view: &Value) -> Vec<(String, String)> {
    view["available"].as_array().unwrap().iter()
        .map(|a| (a["template"]["id"].as_str().unwrap().to_owned(), a["source"].as_str().unwrap().to_owned())).collect()
}

/// T-34 S1: the user keeps the Workspace's templates and each Project's own
/// through their routes, each list against the version read. A dispatch of a
/// task in a Project gets the Project's template of an id before the
/// Workspace's; elsewhere, the Workspace's. A Project's go with it.
#[tokio::test]
async fn templates_are_saved_against_the_version_read_and_a_project_s_own_come_first() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let p = ws.store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/project".into())])).unwrap().id;
    let (status, empty) = call(&ws, "GET", "/api/executor-templates", None).await;
    assert_eq!((status, empty["workspace"].clone(), empty["available"].clone()),
        (StatusCode::OK, json!({"version":0,"templates":[]}), json!([])));

    let mut events = ws.changes.subscribe(None);
    let writer = json!({"id":"writer","label":"Writer","harness":"claude","permissionMode":"auto",
        "namePattern":"{label} for {task}","instructions":"Read the task's acceptance first.","maxConcurrent":2});
    let (status, saved) = call(&ws, "PUT", "/api/executor-templates",
        Some(json!({"expectedVersion":0,"templates":[template("reviewer", "codex"), writer.clone()]}))).await;
    assert_eq!((status, saved["workspace"]["version"].clone()), (StatusCode::OK, json!(1)), "{saved}");
    assert_eq!(saved["workspace"]["templates"][1], writer, "kept as saved");
    let announced: Value = serde_json::from_str(&events.try_next().expect("a kept save is announced").data).unwrap();
    assert_eq!((announced["type"].clone(), announced["executorTemplates"].clone()), (json!("workspace.changed"), json!(true)));

    let (status, stale) = call(&ws, "PUT", "/api/executor-templates", Some(json!({"expectedVersion":0,"templates":[]}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a save against a stale version is refused: {stale}");
    assert!(stale["error"].as_str().unwrap().starts_with("version_conflict: these executor templates changed"), "{stale}");

    let own = json!({"id":"reviewer","label":"Project reviewer","harness":"claude"});
    let path = format!("/api/projects/{p}/executor-templates");
    let (status, project) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":0,"templates":[own.clone()]}))).await;
    assert_eq!((status, project["project"]["version"].clone()), (StatusCode::OK, json!(1)), "{project}");
    let (_, seen) = call(&ws, "GET", &format!("/api/executor-templates?projectId={p}"), None).await;
    assert_eq!(ids(&seen), [("reviewer".into(), "project".into()), ("writer".into(), "workspace".into())],
        "the Project's reviewer stands in for the Workspace's");
    assert_eq!(ids(&saved), [("reviewer".into(), "workspace".into()), ("writer".into(), "workspace".into())]);

    let got = |project: Option<&str>, id: &str| ws.store.executor_template(project, id).unwrap()
        .map(|(t, source)| (t.label, source));
    assert_eq!(got(Some(&p), "reviewer"), Some(("Project reviewer".into(), "project")), "the Project's own template comes first");
    assert_eq!(got(Some(&p), "writer"), Some(("Writer".into(), "workspace")));
    assert_eq!(got(None, "reviewer"), Some(("Label reviewer".into(), "workspace")));
    assert_eq!(got(Some(&p), "absent"), None);

    let (status, missing) = call(&ws, "PUT", "/api/projects/nope/executor-templates", Some(json!({"expectedVersion":0,"templates":[]}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{missing}");
    // An empty list is kept, with its version moved on, so a stale view can't save over it.
    let (_, cleared) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":1,"templates":[]}))).await;
    assert_eq!(cleared["project"], json!({"id":p,"version":2,"templates":[]}));
    let (status, _) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":1,"templates":[own]}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    ws.store.delete_project(&p).unwrap();
    let rows: i64 = ws.store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM workspace_meta WHERE key=?1", [project_key(&p)], |r| r.get(0)).unwrap();
    assert_eq!(rows, 0, "a deleted Project's templates go with it");
}

/// T-34 S1, R1 de0ae592: a save keeps as it was what a later Core stored
/// that this one can't read: a saved template's fields it doesn't know, the
/// templates it can't read, and the list's own fields. The view says how
/// many templates it can't show; a save naming such a template's id
/// replaces it.
#[tokio::test]
async fn a_save_keeps_what_a_later_core_stored() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let later = json!({"id":"z","label":"A later shape","laterHarness":{"kind":"remote"}});
    // A later Core's templates that read, but hold what this Core refuses (R2 70093e91).
    let refused = [json!({"id":"g","label":"Another harness","harness":"gemini"}),
        json!({"id":"m","label":"On another machine","harness":"codex","machineId":"lab-mac"})];
    ws.store.db.write().unwrap().execute("INSERT INTO workspace_meta(key,value) VALUES(?1,?2)", params![KEY,
        json!({"version":1,"laterList":"kept","templates":[{"id":"a","label":"A","harness":"codex","laterField":"kept"}, later.clone(),
            refused[0].clone(), refused[1].clone()]}).to_string()]).unwrap();
    let stored = || -> Value { serde_json::from_str(&ws.store.db.read().unwrap()
        .query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get::<_, String>(0)).unwrap()).unwrap() };
    let (_, seen) = call(&ws, "GET", "/api/executor-templates", None).await;
    assert!(!ids(&seen).iter().any(|(id, _)| id == "g" || id == "m"), "a later Core template that reads but this Core refuses is not offered");
    assert!(ws.store.executor_template(None, "m").unwrap().is_none(), "nor given to a dispatch");
    assert_eq!((ids(&seen), seen["workspace"]["laterTemplates"].clone()), (vec![("a".into(), "workspace".into())], json!(3)),
        "the view shows what it can use and says how many it can't");

    let (status, saved) = call(&ws, "PUT", "/api/executor-templates", Some(json!({"expectedVersion":1,"templates":[
        {"id":"a","label":"A again","harness":"codex"}, template("b", "claude")]}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    let raw = stored();
    assert_eq!(raw["templates"][0], json!({"id":"a","label":"A again","harness":"codex","laterField":"kept"}),
        "a later Core's field of a template is kept");
    assert_eq!(raw["templates"][1], template("b", "claude"));
    assert_eq!(raw["templates"][2], later, "a template a later Core stored is kept");
    assert_eq!(raw["templates"].as_array().unwrap()[3..], refused, "a later Core template this Core refuses is kept by a save");
    assert_eq!((raw["version"].clone(), raw["laterList"].clone()), (json!(2), json!("kept")));
    assert_eq!(saved["workspace"]["laterTemplates"], 3);

    let (_, replaced) = call(&ws, "PUT", "/api/executor-templates", Some(json!({"expectedVersion":2,"templates":[template("z", "codex")]}))).await;
    assert_eq!(stored()["templates"].as_array().unwrap().iter().map(|t| t["id"].clone()).collect::<Vec<_>>(), [json!("z"), json!("g"), json!("m")],
        "a save naming its id replaces it; one this Core can use that it leaves out is removed");
    assert_eq!(stored()["templates"][0], template("z", "codex"), "a template replacing one this Core can't use is stored as sent");
    assert_eq!(replaced["workspace"]["laterTemplates"], 2, "{replaced}");
}

/// T-34 S1: a save names only fields this Core knows, each valid, each id
/// once; phase 1's executors are on this Core host. A stored list is read
/// leniently: a later Core's fields and templates this Core can't read are
/// left out, not an error.
#[test]
fn a_template_is_checked_strictly_and_read_leniently() {
    let refused = |template: Value| parse_save(&[template], true, &[]).err().map_or_else(|| "accepted".to_owned(), |e| e.to_string());
    let with = |extra: Value| {
        let mut t = template("t", "codex");
        t.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        t
    };
    for (template, says) in [
        (with(json!({"extra":1})), "Unknown template field: extra"),
        (with(json!({"id":"Not ok"})), "A template's id is 1 to 48 lowercase letters"),
        (with(json!({"label":" "})), "A template's label is a line of at most 80 characters"),
        (with(json!({"harness":"gemini"})), "A template's harness is Codex, Claude Code or OpenCode, not gemini"),
        (with(json!({"permissionMode":"auto"})), "A Claude Code permission mode does not apply to a Codex template"),
        (with(json!({"permissionPreset":"root"})), "Unknown Codex permission mode: root"),
        (with(json!({"reasoningEffort":"high"})), "Choose the Codex model the reasoning effort is for"),
        (with(json!({"harness":"claude","permissionPreset":"auto"})), "A Codex permission mode does not apply to a Claude Code template"),
        (with(json!({"harness":"claude","reasoningEffort":"high","model":"m"})), "A Claude Code template takes no reasoning effort"),
        (with(json!({"harness":"opencode","model":"m"})), "An OpenCode template takes no model"),
        (with(json!({"machineId":"lab-mac"})), "Executors run on this Core host in this phase, not on lab-mac; other machines come with phase 2 (T-35)"),
        (with(json!({"instructions":"x".repeat(MAX_INSTRUCTIONS + 1)})), "A template's instructions are at most 8 KiB"),
        (with(json!({"namePattern":"{title} done"})), "A name pattern can use {task} and {label}, not {title}"),
        (with(json!({"namePattern":"{task"})), "A name pattern's `{` is not closed"),
        (with(json!({"maxConcurrent":0})), "At most 1 to 64 executors of one template at once"),
    ] {
        let got = refused(template.clone());
        assert!(got.starts_with(says), "{template} should be refused with {says}; got: {got}");
    }
    let off = parse_save(&[template("o", "opencode")], false, &[]).unwrap_err().to_string();
    assert_eq!(off, "OpenCode Agents aren't enabled on this Core");
    assert!(parse_save(&[template("o", "opencode")], true, &[]).is_ok());
    // While OpenCode is off, one saved before stays editable, as it is or
    // changed, so the rest of the list does too; a new one is refused
    // (R2 70093e91, R4 42f066e2: the editor rebuilds each template it sends).
    let kept: Template = serde_json::from_value(json!({"id":"o","label":"Label o","harness":"opencode","machineId":"local"})).unwrap();
    let renamed = json!({"id":"o","label":"Renamed","harness":"opencode"});
    assert!(parse_save(&[renamed, template("c", "codex")], false, &[kept.clone()]).is_ok(),
        "an OpenCode template saved before stays editable while OpenCode is off");
    assert_eq!(parse_save(&[template("n", "opencode")], false, &[kept.clone()]).unwrap_err().to_string(), "OpenCode Agents aren't enabled on this Core");
    let codex: Template = serde_json::from_value(template("c", "codex")).unwrap();
    assert_eq!(parse_save(&[template("c", "opencode")], false, &[codex]).unwrap_err().to_string(), "OpenCode Agents aren't enabled on this Core",
        "no template becomes an OpenCode one while OpenCode is off");
    let twice = parse_save(&[template("a", "codex"), template("a", "claude")], true, &[]).unwrap_err().to_string();
    assert_eq!(twice, "Each template id must be used once");
    let many: Vec<Value> = (0..=MAX_TEMPLATES).map(|n| template(&format!("t{n}"), "codex")).collect();
    assert_eq!(parse_save(&many, true, &[]).unwrap_err().to_string(), "At most 50 templates");
    let fine = parse_save(&[with(json!({"machineId":"local","namePattern":"{label} — {task}",
        "instructions":"x".repeat(MAX_INSTRUCTIONS)}))], true, &[]).unwrap();
    assert_eq!(fine[0].machine_id.as_deref(), Some("local"));

    let read = read_list(Some(json!({"version":3,"later":true,"templates":[
        {"id":"a","label":"Label a","harness":"codex","laterField":"kept out"},
        {"label":"no id: a later shape"},
        {"id":"g","label":"Reads, but another harness","harness":"gemini"},
    ]}).to_string())).unwrap();
    assert_eq!((read.version, read.later_templates), (3, 2));
    assert_eq!(read.templates, vec![serde_json::from_value::<Template>(template("a", "codex").clone()).unwrap()]);
    assert_eq!(read_list(None).unwrap(), Templates::default());
}

/// T-34 S1: a model a template names is confirmed by this Core host's
/// catalog, as the catalog names it, as the defaults for new Agents are; one
/// left as the saved template of its id had it is not read again.
#[test]
fn a_named_model_is_confirmed_by_the_core_hosts_catalog() {
    let codex = json!({"models":[{"id":"m-small","model":"m-small","supportedReasoningEfforts":[{"reasoningEffort":"low"}]}]});
    let claude = json!({"models":[{"id":"opus","model":"opus","displayName":"Opus","supportsAutoMode":false}]});
    let catalogs = Catalogs { codex: Some(Ok(codex)), claude: Some(Ok(claude)) };
    let parse = |values: Vec<Value>| parse_save(&values, true, &[]).unwrap();
    let mut fine = parse(vec![json!({"id":"c","label":"C","harness":"codex","model":"m-small","reasoningEffort":"low"})]);
    confirm_models(&mut fine, &[], &catalogs).unwrap();
    assert_eq!(fine[0].model.as_deref(), Some("m-small"));
    let mut gone = parse(vec![json!({"id":"c","label":"C","harness":"codex","model":"gone"})]);
    let says = confirm_models(&mut gone, &[], &catalogs).err().map(|e| e.to_string()).unwrap_or_default();
    assert!(says.starts_with("C: ") && says.contains("not among this Core host's Codex models") && says.ends_with("nothing was saved"),
        "a model not in the catalog is refused: {says:?}");
    let mut auto = parse(vec![json!({"id":"o","label":"O","harness":"claude","model":"opus","permissionMode":"auto"})]);
    assert_eq!(confirm_models(&mut auto, &[], &catalogs).unwrap_err().to_string(), "O: opus can't run in Auto mode; nothing was saved");
    // Unchanged from what is saved: no catalog is needed.
    let unread = Catalogs { codex: None, claude: None };
    let saved = fine.clone();
    confirm_models(&mut fine, &saved, &unread).unwrap();
    let mut changed = parse(vec![json!({"id":"c","label":"C","harness":"codex","model":"m-small"})]);
    assert_eq!(confirm_models(&mut changed, &saved, &unread).unwrap_err().to_string(),
        "Can't read this Core host's Codex models; nothing was saved", "its effort changed");
}
