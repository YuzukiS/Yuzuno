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

/// T-34 S1, YN-2 S2: the user keeps the Workspace's templates through its
/// route, against the version read. They are the only list: a page from
/// before saving a Project's own is told where templates are, and nothing is
/// written; a dispatch of a task in a Project gets the Workspace's. A
/// Project's own list from before goes with it.
#[tokio::test]
async fn templates_are_the_workspaces_saved_against_the_version_read() {
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
    let mut kept = writer.clone();
    kept.as_object_mut().unwrap().remove("maxConcurrent");
    assert_eq!(saved["workspace"]["templates"][1], kept, "kept as saved, but an older page's maxConcurrent is dropped (YN-2 S5)");
    let announced: Value = serde_json::from_str(&events.try_next().expect("a kept save is announced").data).unwrap();
    assert_eq!((announced["type"].clone(), announced["executorTemplates"].clone()), (json!("workspace.changed"), json!(true)));

    let (status, stale) = call(&ws, "PUT", "/api/executor-templates", Some(json!({"expectedVersion":0,"templates":[]}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "a save against a stale version is refused: {stale}");
    assert!(stale["error"].as_str().unwrap().starts_with("version_conflict: these executor templates changed"), "{stale}");

    let own = json!({"id":"reviewer","label":"Project reviewer","harness":"claude"});
    let path = format!("/api/projects/{p}/executor-templates");
    let (status, refused) = call(&ws, "PUT", &path, Some(json!({"expectedVersion":0,"templates":[own]}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
    assert!(refused["error"].as_str().unwrap().starts_with("setting_moved: executor templates are kept for the whole Workspace now"),
        "a page from before is told where templates are: {refused}");
    let rows = |key: String| -> i64 { ws.store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM workspace_meta WHERE key=?1", [key], |r| r.get(0)).unwrap() };
    assert_eq!(rows(project_key(&p)), 0, "nothing was written for the Project");
    let (status, seen) = call(&ws, "GET", &format!("/api/executor-templates?projectId={p}"), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(ids(&seen), [("reviewer".into(), "workspace".into()), ("writer".into(), "workspace".into())],
        "a Project's view offers the Workspace's templates");
    assert!(seen.get("project").is_none(), "and no list of its own: {seen}");
    assert_eq!(seen["presets"].as_array().map(Vec::len), Some(20), "ten presets in two languages (YN-23)");
    assert_eq!(ws.store.executor_template("reviewer").unwrap().map(|t| t.label), Some("Label reviewer".into()));
    assert_eq!(ws.store.executor_template("absent").unwrap(), None);
    let (status, missing) = call(&ws, "GET", "/api/executor-templates?projectId=nope", None).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{missing}");

    // A Project's own list from before YN-2 S2 goes with it.
    ws.store.db.write().unwrap().execute("INSERT INTO workspace_meta(key,value) VALUES(?1,?2)",
        params![project_key(&p), json!({"version":1,"templates":[template("old", "codex")]}).to_string()]).unwrap();
    ws.store.delete_project(&p).unwrap();
    assert_eq!(rows(project_key(&p)), 0, "a deleted Project's templates go with it");
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
        json!({"id":"m","label":"Yet another harness","harness":"kimi"})];
    ws.store.db.write().unwrap().execute("INSERT INTO workspace_meta(key,value) VALUES(?1,?2)", params![KEY,
        json!({"version":1,"laterList":"kept","templates":[{"id":"a","label":"A","harness":"codex","laterField":"kept"}, later.clone(),
            refused[0].clone(), refused[1].clone()]}).to_string()]).unwrap();
    let stored = || -> Value { serde_json::from_str(&ws.store.db.read().unwrap()
        .query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get::<_, String>(0)).unwrap()).unwrap() };
    let (_, seen) = call(&ws, "GET", "/api/executor-templates", None).await;
    assert!(!ids(&seen).iter().any(|(id, _)| id == "g" || id == "m"), "a later Core template that reads but this Core refuses is not offered");
    assert!(ws.store.executor_template("m").unwrap().is_none(), "nor given to a dispatch");
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
/// once; a template may name a machine for its executors (T-35 S3a). A stored list is read
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
        (with(json!({"harness":"opencode","model":"m"})), "An OpenCode model is named <provider>/<model>"),
        (with(json!({"harness":"opencode","model":"deepseek/deepseek-flash","reasoningEffort":"high"})), "An OpenCode template takes no reasoning effort"),
        // YN-34 S3a: a template follows routing, or is fixed against it.
        (with(json!({"routing":"auto"})), "A template's routing is \"fixed\" or unset"),
        // T-35 S3a: a machine is named by its id.
        (with(json!({"machineId":""})), "A machine is named by its id, at most 128 characters"),
        (with(json!({"harness":"opencode","machineId":"lab-mac"})), "OpenCode executors run on this Core host only, not on lab-mac"),
        (with(json!({"instructions":"x".repeat(MAX_INSTRUCTIONS + 1)})), "A template's instructions are at most 8 KiB"),
        (with(json!({"namePattern":"{title} done"})), "A name pattern can use {task} and {label}, not {title}"),
        (with(json!({"namePattern":"{task"})), "A name pattern's `{` is not closed"),
    ] {
        let got = refused(template.clone());
        assert!(got.starts_with(says), "{template} should be refused with {says}; got: {got}");
    }
    let named = parse_save(&[with(json!({"machineId":"lab-mac"}))], true, &[]).unwrap();
    assert_eq!(named[0].machine_id.as_deref(), Some("lab-mac"), "a template may name a machine (T-35 S3a)");
    // T-35 S3b: or say `auto`, for Core to choose at each dispatch; an OpenCode one's chooses this Core host.
    for harness in ["codex", "opencode"] {
        let auto = parse_save(&[with(json!({"harness":harness,"machineId":"auto"}))], true, &[]).unwrap();
        assert_eq!(auto[0].machine_id.as_deref(), Some("auto"), "{harness}: a template may say auto");
    }
    // YN-2 S5: a template has no limit of its own; an older page's
    // maxConcurrent is taken and dropped, whatever it says, for one release.
    for limit in [json!(1), json!(64), json!(0), json!(65), json!(2.5), json!("2"), Value::Null] {
        let saved = parse_save(&[with(json!({"maxConcurrent":limit}))], true, &[]).unwrap();
        assert!(serde_json::to_value(&saved[0]).unwrap().get("maxConcurrent").is_none(), "{limit} is dropped");
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

/// YN-23: Core offers the ten presets of T-43's plan in English and Chinese,
/// each a template once the page gives it a harness: every one passes a
/// save's checks for Codex and for Claude Code, with its permission for that
/// harness, and its instructions fit the 8 KiB a template has. The view
/// serves them; nothing stores them.
#[tokio::test]
async fn the_ten_presets_are_templates_in_both_languages() {
    let presets = presets();
    let ids = ["design-first", "red-test-fix", "batch-change", "investigation", "decision-memo", "verification",
        "sliced-feature", "runbook", "small-fix", "test-hygiene"];
    for language in PRESET_LANGUAGES {
        let these: Vec<&Value> = presets.iter().filter(|p| p["language"] == language).collect();
        assert_eq!(these.iter().map(|p| p["id"].as_str().unwrap()).collect::<Vec<_>>(), ids, "{language}: the ten, in order");
    }
    for preset in &presets {
        let (id, language) = (preset["id"].as_str().unwrap(), preset["language"].as_str().unwrap());
        let instructions = preset["instructions"].as_str().unwrap();
        assert!(instructions.len() <= MAX_INSTRUCTIONS, "{id} {language}: {} bytes", instructions.len());
        assert!(!preset["modelHint"].as_str().unwrap().trim().is_empty(), "{id} {language}: a model hint");
        let steps = preset["steps"].as_array().map(|steps| steps.iter().map(|s| s["label"].clone()).collect::<Vec<_>>()).unwrap_or_default();
        assert!(steps.iter().all(|label| label.is_null() || label.is_string()), "{id} {language}: step labels in its language: {steps:?}");
        for harness in ["codex", "claude"] {
            let mut template = json!({"id": id, "label": preset["label"], "harness": harness, "instructions": instructions,
                "whenToChoose": preset["whenToChoose"], "deliveryMode": preset["deliveryMode"]});
            if let Some(steps) = preset.get("steps") {
                template["steps"] = steps.clone();
            }
            if let Some(permission) = preset["permissions"][harness].as_str() {
                template[if harness == "codex" { "permissionPreset" } else { "permissionMode" }] = json!(permission);
            }
            let saved = parse_save(&[template.clone()], false, &[]);
            assert!(saved.is_ok(), "{id} {language} {harness}: {saved:?}");
        }
    }
    let runbook = presets.iter().find(|p| p["id"] == "runbook").unwrap();
    assert_eq!(runbook["permissions"], json!({"codex":"ask","claude":"default"}), "the gated runbook asks before each action");
    let zh = presets.iter().find(|p| p["id"] == "design-first" && p["language"] == "zh-Hans").unwrap();
    assert_eq!((zh["label"].clone(), zh["steps"][1]["label"].clone()), (json!("设计先行"), json!("设计说明")));

    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let (_, view) = call(&ws, "GET", "/api/executor-templates", None).await;
    assert_eq!(view["presets"], json!(presets), "the view serves them");
    assert_eq!(view["workspace"]["templates"], json!([]), "and stores none");
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

/// YN-2 S1: the templates' view says what a general executor (`executor: {}`)
/// of the read Project would be made with now: its harness and where that
/// default comes from, the Project's, the Workspace's or the built-in one.
#[tokio::test]
async fn the_view_says_what_a_general_executor_would_be_made_with() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let p = ws.store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/project".into())])).unwrap().id;
    let general = |harness: &str, source: &str| json!({"label":"Executor","harness":harness,"harnessSource":source});
    let (_, view) = call(&ws, "GET", "/api/executor-templates", None).await;
    assert_eq!(view["general"], general("codex", "builtin"), "the view names the general executor: {view}");
    ws.store.save_agent_defaults(&crate::agent_defaults::AgentDefaults { harness: Some("claude".into()), ..Default::default() }).unwrap();
    let (_, view) = call(&ws, "GET", &format!("/api/executor-templates?projectId={p}"), None).await;
    assert_eq!(view["general"], general("claude", "workspace"));
    ws.store.save_project_agent_defaults(&p, &crate::agent_defaults::AgentDefaults { harness: Some("codex".into()), ..Default::default() }).unwrap();
    let (_, view) = call(&ws, "GET", &format!("/api/executor-templates?projectId={p}"), None).await;
    assert_eq!(view["general"], general("codex", "project"));
}

/// A list stored at `key`, as an earlier Core saved it.
fn stored_at(store: &Store, key: &str, list: Value) {
    store.db.write().unwrap().execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, list.to_string()]).unwrap();
}

fn raw_at(store: &Store, key: &str) -> Value {
    serde_json::from_str(&store.db.read().unwrap().query_row("SELECT value FROM workspace_meta WHERE key=?1", [key], |r| r.get::<_, String>(0)).unwrap()).unwrap()
}

/// YN-2 S2: on open, each Project's own templates an earlier Core kept are
/// copied into the Workspace's list once. One the Workspace has as it is is
/// not copied; one whose id it uses for another gets a free id and its
/// Project's name in its label; each copy says where it came from. The
/// Project lists stay as they were, a template this Core can't read stays in
/// its list, and opening again copies nothing more, until an older Core saves
/// a Project's list again: then only what changed is copied.
#[test]
fn project_templates_are_copied_into_the_workspace_once_and_stay_stored() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    let store = Store::open(&path).unwrap();
    let lab = store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/lab".into())])).unwrap().id;
    let field = store.create_project("Field", BTreeMap::from([("local".into(), "/synthetic/field".into())])).unwrap().id;
    let writer = json!({"id":"writer","label":"Writer","harness":"claude"});
    stored_at(&store, KEY, json!({"version":4,"templates":[template("reviewer", "codex"), writer.clone()]}));
    let lab_list = json!({"version":3,"templates":[
        {"id":"reviewer","label":"Reviewer","harness":"claude","instructions":"Lab's way."},
        writer.clone(),
        {"id":"tester","label":"Tester","harness":"codex","maxConcurrent":2},
        {"id":"g","label":"Another harness","harness":"gemini"}]});
    stored_at(&store, &project_key(&lab), lab_list.clone());
    stored_at(&store, &project_key(&field), json!({"version":1,"templates":[{"id":"reviewer","label":"Reviewer","harness":"claude","instructions":"Field's way."}]}));
    drop(store);

    let store = Store::open(&path).unwrap();
    let workspace = raw_at(&store, KEY);
    let by_id = |list: &Value, id: &str| list["templates"].as_array().unwrap().iter().find(|t| t["id"] == id).cloned();
    assert_eq!(workspace["version"], 5, "the Workspace's list moved on once: {workspace}");
    assert_eq!(workspace["templates"].as_array().unwrap().len(), 5,
        "its two, Lab's reviewer and tester, and Field's reviewer; Lab's writer was already there: {workspace}");
    assert_eq!(by_id(&workspace, "reviewer"), Some(template("reviewer", "codex")), "the Workspace's own reviewer keeps its id");
    let copies: Vec<Value> = workspace["templates"].as_array().unwrap().iter().filter(|t| t["origin"].is_object()).cloned().collect();
    let copy_of = |project: &str, id: &str| copies.iter().find(|t| t["origin"]["projectId"] == project && t["origin"]["id"] == id).cloned()
        .unwrap_or_else(|| panic!("no copy of {project}'s {id}: {workspace}"));
    let lab_reviewer = copy_of(&lab, "reviewer");
    assert!(matches!(lab_reviewer["id"].as_str(), Some("reviewer-2" | "reviewer-3")), "a free id: {lab_reviewer}");
    assert_eq!((lab_reviewer["label"].clone(), lab_reviewer["instructions"].clone(), lab_reviewer["origin"]["projectName"].clone()),
        (json!("Reviewer (Lab)"), json!("Lab's way."), json!("Lab")));
    let field_reviewer = copy_of(&field, "reviewer");
    assert_ne!(field_reviewer["id"], lab_reviewer["id"], "each copy gets its own id");
    assert_eq!(field_reviewer["label"], "Reviewer (Field)");
    assert_eq!(copy_of(&lab, "tester"), json!({"id":"tester","label":"Tester","harness":"codex","maxConcurrent":2,
        "origin":{"projectId":lab,"projectName":"Lab","id":"tester"}}), "an id the Workspace doesn't use is kept, label and all");
    assert!(by_id(&workspace, "g").is_none(), "a template this Core can't read stays in its Project's list");
    assert_eq!(raw_at(&store, &project_key(&lab)), lab_list, "the Project's list is left as it was");
    let read = store.executor_templates().unwrap();
    assert_eq!((read.templates.len(), read.later_templates), (5, 0), "every copy is one this Core can use");
    drop(store);

    let store = Store::open(&path).unwrap();
    assert_eq!(raw_at(&store, KEY), workspace, "opening again copies nothing more");
    // An older Core saves Lab's list again: only its changed tester is copied.
    let mut again = lab_list.clone();
    again["version"] = json!(4);
    again["templates"][2]["maxConcurrent"] = json!(3);
    stored_at(&store, &project_key(&lab), again);
    drop(store);
    let store = Store::open(&path).unwrap();
    let after = raw_at(&store, KEY);
    assert_eq!((after["version"].clone(), after["templates"].as_array().unwrap().len()), (json!(6), 6), "{after}");
    let changed = after["templates"].as_array().unwrap().last().unwrap().clone();
    assert_eq!((changed["id"].clone(), changed["label"].clone(), changed["maxConcurrent"].clone()),
        (json!("tester-2"), json!("Tester (Lab)"), json!(3)));
}

/// YN-2 S2: copies may take the Workspace's list past 50 templates. A save
/// keeps what it holds, but adds none past it; the view says the limit.
#[tokio::test]
async fn a_list_the_copy_took_past_the_limit_still_saves() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let p = ws.store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/lab".into())])).unwrap().id;
    let list = |prefix: &str| -> Vec<Value> { (0..30).map(|n| template(&format!("{prefix}-{n}"), "codex")).collect() };
    stored_at(&ws.store, KEY, json!({"version":1,"templates":list("w")}));
    stored_at(&ws.store, &project_key(&p), json!({"version":1,"templates":list("p")}));
    // As the next open does.
    migrate(&ws.store.db.write().unwrap()).unwrap();
    let (_, view) = call(&ws, "GET", "/api/executor-templates", None).await;
    assert_eq!((view["workspace"]["templates"].as_array().unwrap().len(), view["limits"]["templates"].clone()), (60, json!(60)));
    let all: Vec<Value> = view["workspace"]["templates"].as_array().unwrap().clone();
    let (status, saved) = call(&ws, "PUT", "/api/executor-templates", Some(json!({"expectedVersion":2,"templates":all}))).await;
    assert_eq!(status, StatusCode::OK, "a save keeps what the list holds: {saved}");
    let mut more = all.clone();
    more.push(template("extra", "codex"));
    let (status, refused) = call(&ws, "PUT", "/api/executor-templates", Some(json!({"expectedVersion":3,"templates":more}))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(refused["error"].as_str().unwrap().contains("At most 60 templates"), "{refused}");
}

/// YN-23: a template says how its work is delivered, the steps its
/// executors follow and when to choose it. A save takes them as sent and a
/// read gives them back; left unset, a template is delivered by pull request
/// with that mode's steps, as before.
#[tokio::test]
async fn a_templates_delivery_steps_and_when_to_choose_round_trip_through_a_save() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let design = json!({"id":"design-first","label":"Design first","harness":"codex","deliveryMode":"pr",
        "whenToChoose":"UI or cross-module work the user should see before code",
        "steps":[{"kind":"materials"},{"kind":"work","label":"设计说明"},{"kind":"result","label":"设计说明"},
            {"kind":"gate","label":"批准设计说明","approver":"either"},{"kind":"work","label":"切片实现"},{"kind":"job"},{"kind":"pr"},
            {"kind":"review","rounds":2},{"kind":"ci"},{"kind":"merge"}]});
    let memo = json!({"id":"memo","label":"Memo","harness":"claude","deliveryMode":"none","routing":"fixed"});
    let commit = json!({"id":"results","label":"Results","harness":"codex","deliveryMode":"direct-commit"});
    let (status, saved) = call(&ws, "PUT", "/api/executor-templates",
        Some(json!({"expectedVersion":0,"templates":[design.clone(), memo.clone(), commit.clone(), template("plain", "codex")]}))).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    assert_eq!(saved["workspace"]["templates"], json!([design, memo, commit, template("plain", "codex")]), "kept as sent");
    let read = ws.store.executor_templates().unwrap().templates;
    let kinds = |t: &Template| t.resolved_steps().iter().map(|s| s.kind.clone()).collect::<Vec<_>>().join(" ");
    assert_eq!(read.iter().map(|t| (t.delivery().to_owned(), kinds(t))).collect::<Vec<_>>(), [
        ("pr".to_owned(), "materials work result gate work job pr review ci merge".to_owned()),
        ("none".into(), "materials work result".into()),
        ("direct-commit".into(), "materials work job result".into()),
        ("pr".into(), "materials work job pr review ci merge".into()),
    ], "a template's own steps, else its mode's; unset is pr");
    assert_eq!(read[0].given("workspace")["steps"][3], json!({"kind":"gate","label":"批准设计说明","approver":"either"}));
    assert!(Template::general("codex".into()).given("builtin").get("deliveryMode").is_none(), "the general executor has neither");
}

/// YN-23: steps and the delivery mode are checked as the editor shows them,
/// each step by its place; a later Core's mode, kind or step field makes
/// its template one this Core doesn't offer, kept as it is by a save.
#[test]
fn delivery_and_steps_are_checked_strictly_and_a_later_cores_are_kept() {
    let with = |extra: Value| {
        let mut t = template("t", "codex");
        t.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        t
    };
    let steps = |list: Value| with(json!({"steps":list}));
    let refused = |template: Value| parse_save(&[template], true, &[]).err().map_or_else(|| "accepted".to_owned(), |e| e.to_string());
    for (template, says) in [
        (with(json!({"deliveryMode":"pages"})), "A template's delivery is pr, direct-commit or none, not pages"),
        (steps(json!([])), "A template has 1 to 12 steps"),
        (steps(json!((0..13).map(|_| json!({"kind":"work"})).collect::<Vec<_>>())), "A template has 1 to 12 steps"),
        (steps(json!([{"kind":"work"},{"kind":"deploy"}])), "Step 2: a step is materials, work, result, gate, job, pr, review, ci or merge, not deploy"),
        (with(json!({"deliveryMode":"none","steps":[{"kind":"work"},{"kind":"pr"}]})), "Step 2: a pr step is for a template delivered by pull request (pr), not none"),
        (with(json!({"deliveryMode":"direct-commit","steps":[{"kind":"merge"}]})), "Step 1: a merge step is for a template delivered by pull request (pr), not direct-commit"),
        (steps(json!([{"kind":"work","rounds":2}])), "Step 1: only a review step has rounds"),
        (steps(json!([{"kind":"review","rounds":3}])), "Step 1: a review is 1 or 2 rounds"),
        (steps(json!([{"kind":"work","approver":"user"}])), "Step 1: only a gate step has an approver"),
        (steps(json!([{"kind":"gate","approver":"anyone"}])), "Step 1: a gate's approver is user, lead or either, not anyone"),
        (steps(json!([{"kind":"work","label":"x".repeat(61)}])), "Step 1's label is a line of at most 60 characters"),
        (steps(json!([{"kind":"work","label":" "}])), "Step 1's label is a line of at most 60 characters"),
        (steps(json!([{"kind":"work","optional":true}])), "Step 1: unknown step field: optional"),
        (steps(json!(["work"])), "Step 1: a step is an object"),
        (with(json!({"whenToChoose":"two\nlines"})), "When to choose it is a line of at most 200 characters"),
        (with(json!({"whenToChoose":"x".repeat(201)})), "When to choose it is a line of at most 200 characters"),
    ] {
        let got = refused(template.clone());
        assert!(got.starts_with(says), "{template} should be refused with {says}; got: {got}");
    }
    let most = parse_save(&[with(json!({"deliveryMode":"none","whenToChoose":"x".repeat(200),
        "steps":(0..12).map(|_| json!({"kind":"gate","approver":"lead","label":"批".repeat(60)})).collect::<Vec<_>>()}))], true, &[]);
    assert!(most.is_ok(), "12 steps, 60-character labels and a 200-character line are taken: {most:?}");

    let later = [json!({"id":"l1","label":"Later mode","harness":"codex","deliveryMode":"pages"}),
        json!({"id":"l2","label":"Later kind","harness":"codex","steps":[{"kind":"deploy"}]}),
        json!({"id":"l3","label":"Later step field","harness":"codex","steps":[{"kind":"work","optional":true}]})];
    let mut list = later.to_vec();
    list.insert(0, template("a", "codex"));
    let read = read_list(Some(json!({"version":1,"templates":list}).to_string())).unwrap();
    assert_eq!((read.templates.len(), read.later_templates), (1, 3), "only the template this Core can use is offered");
    let stored = stored_list(&read, &read.templates, 2).unwrap();
    assert_eq!(stored["templates"].as_array().unwrap()[1..], later, "a save keeps a later Core's templates as they are");
}

/// YN-23: a lead reads the Workspace's templates with executor_templates_list
/// to choose one: what each is for, how it is delivered, its steps and
/// settings, and the size of its instructions, not their text. Reading
/// changes nothing; no Agent saves templates through it.
#[tokio::test]
async fn a_lead_lists_the_templates_to_choose_one() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let p = ws.store.create_project("Lab", BTreeMap::new()).unwrap().id;
    let detail: crate::model::AgentDetail = serde_json::from_value(json!({"agent":{"id":"lead","name":"Lead","cwd":"/synthetic/work",
        "model":"","harness":"claude","color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&detail).unwrap();
    ws.store.set_agent_project("lead", Some(&p)).unwrap();
    ws.store.save_project_agent_defaults(&p, &crate::agent_defaults::AgentDefaults { harness: Some("claude".into()), ..Default::default() }).unwrap();
    let memo = json!({"id":"memo","label":"决策备忘","harness":"codex","model":"m-large","reasoningEffort":"high","permissionPreset":"ask",
        "machineId":"auto","instructions":"列出选项。","whenToChoose":"A choice the user makes","deliveryMode":"none",
        "steps":[{"kind":"materials"},{"kind":"work"},{"kind":"result","label":"选项表"},{"kind":"gate","approver":"user"}]});
    let later = json!({"id":"later","label":"Later","harness":"gemini"});
    stored_at(&ws.store, KEY, json!({"version":4,"templates":[memo, template("plain", "claude"), later]}));
    let before = raw_at(&ws.store, KEY);

    let listed = ws.collaboration_call(Some("lead"), LIST_TOOL, json!({})).await.unwrap();
    assert_eq!(listed, json!({"version":4,"laterTemplates":1,
        "general":{"label":"Executor","harness":"claude","harnessSource":"project"},
        "templates":[
            {"id":"memo","label":"决策备忘","whenToChoose":"A choice the user makes","deliveryMode":"none",
                "steps":[{"kind":"materials"},{"kind":"work"},{"kind":"result","label":"选项表"},{"kind":"gate","approver":"user"}],
                "harness":"codex","model":"m-large","reasoningEffort":"high","permissionPreset":"ask","machineId":"auto",
                "instructionsBytes":"列出选项。".len()},
            {"id":"plain","label":"Label plain","deliveryMode":"pr",
                "steps":[{"kind":"materials"},{"kind":"work"},{"kind":"job"},{"kind":"pr"},{"kind":"review"},{"kind":"ci"},{"kind":"merge"}],
                "harness":"claude","instructionsBytes":0},
        ]}), "{listed}");
    assert!(!listed.to_string().contains("列出选项"), "its instructions' size, not their text");
    assert_eq!(raw_at(&ws.store, KEY), before, "reading changes nothing");
    let general = ws.collaboration_call(None, LIST_TOOL, json!({})).await.unwrap();
    assert_eq!(general["general"]["harnessSource"], "builtin", "the user's read: the Workspace's general executor");
    let extra = ws.collaboration_call(Some("lead"), LIST_TOOL, json!({"templates":[]})).await.unwrap_err().to_string();
    assert_eq!(extra, "invalid_input: unknown field templates", "it takes nothing to save");

    let tool = crate::collaboration_store::tool_definitions().into_iter().find(|t| t["name"] == LIST_TOOL).expect("offered to Agents");
    assert!(tool["description"].as_str().unwrap().encode_utf16().count() <= crate::results::max_description_length());
    assert_eq!(tool["inputSchema"]["properties"].as_object().unwrap().keys().collect::<Vec<_>>(), ["full"]);
}

