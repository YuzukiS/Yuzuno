use super::*;
use crate::model::AgentDetail;
use axum::http::StatusCode;
use std::collections::BTreeMap;
use tower::ServiceExt;

fn agent_detail(id: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work","model":"","harness":"claude",
        "color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()
}

fn template(id: &str, label: &str, harness: &str) -> Value {
    json!({"id":id,"label":label,"harness":harness,"routing":"fixed","instructions":format!("Work as {label}.")})
}

/// Lab with two leads, a member and an executor of its own; Other with a
/// lead; an Agent of no Project. The user saved two templates (version 1).
async fn fixture() -> (tempfile::TempDir, Arc<Workspace>, String) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    let lab = ws.store.create_project("Lab", BTreeMap::new()).unwrap().id;
    let other = ws.store.create_project("Other", BTreeMap::new()).unwrap().id;
    for id in ["lead", "lead2", "member", "exec", "outsider", "otherlead"] {
        ws.store.insert(&agent_detail(id)).unwrap();
    }
    for id in ["lead", "lead2", "member", "exec"] {
        ws.store.set_agent_project(id, Some(&lab)).unwrap();
    }
    ws.store.set_agent_project("otherlead", Some(&other)).unwrap();
    crate::agent_roles::save(&ws.store, &lab, 0, vec!["lead".into(), "lead2".into()]).unwrap();
    crate::agent_roles::save(&ws.store, &other, 0, vec!["otherlead".into()]).unwrap();
    ws.store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id, kind, project_id, created_at, updated_at) VALUES('exec','executor',?1,'now','now')", [&lab]).unwrap();
    let (status, saved) = user_save(&ws, 0, json!([template("dev", "Dev", "claude"), template("review", "Review", "codex")])).await;
    assert_eq!(status, StatusCode::OK, "{saved}");
    (dir, ws, lab)
}

async fn route(ws: &Arc<Workspace>, method: &str, path: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut request = axum::http::Request::builder().method(method).uri(path);
    if body.is_some() {
        request = request.header("content-type", "application/json");
    }
    let request = request.body(body.map_or_else(axum::body::Body::empty, |b| axum::body::Body::from(b.to_string()))).unwrap();
    let response = crate::executor_templates::router().with_state(ws.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

/// The user's save in Settings.
async fn user_save(ws: &Arc<Workspace>, expected: i64, templates: Value) -> (StatusCode, Value) {
    route(ws, "PUT", "/api/executor-templates", Some(json!({"expectedVersion":expected,"templates":templates}))).await
}

fn put(template: Value) -> Value {
    json!({"op":"put","template":template})
}

fn change(request: &str, expected: i64, changes: Value) -> Value {
    json!({"requestId":request,"expectedVersion":expected,"changes":changes,"reason":"Say how to test"})
}

fn dev_with(instructions: &str) -> Value {
    json!({"id":"dev","label":"Dev","harness":"claude","routing":"fixed","instructions":instructions})
}

fn error_of(result: Result<Value>) -> String {
    result.err().map_or_else(|| "accepted".to_owned(), |e| format!("{e:#}"))
}

fn mail_to(store: &Store, agent: &str) -> Vec<String> {
    let db = store.db.read().unwrap();
    let mut query = db.prepare("SELECT json_extract(data,'$.body') FROM collaboration_messages WHERE recipient_id=?1 ORDER BY rowid").unwrap();
    query.query_map([agent], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

fn saved(ws: &Arc<Workspace>) -> Templates {
    ws.store.executor_templates().unwrap()
}

fn history(ws: &Arc<Workspace>) -> Vec<(i64, String, Option<String>, Value)> {
    let db = ws.store.db.read().unwrap();
    let mut query = db.prepare("SELECT version, author_name, reason, changes FROM executor_template_changes ORDER BY id").unwrap();
    query.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, serde_json::from_str(&r.get::<_, String>(3)?).unwrap())))
        .unwrap().collect::<rusqlite::Result<_>>().unwrap()
}

/// YN-24, the user's decision: a lead's change is saved at once with its
/// reason, as the next version; the history keeps who, why, and each
/// template as it was and as it is; the Project's other leads get one mail;
/// the user's Settings shows who changed each template last.
#[tokio::test]
async fn a_lead_changes_templates_at_once_with_its_reason() {
    let (_dir, ws, _) = fixture().await;
    // As a lead does it: read the templates whole, change one, send it back.
    let read = ws.collaboration_call(Some("lead"), crate::executor_templates::LIST_TOOL, json!({"full":true})).await.unwrap();
    let mut dev = read["templates"][0]["template"].clone();
    dev["instructions"] = json!("Write a test first.");
    let saved_now = ws.collaboration_call(Some("lead"), TOOL, change("first", read["version"].as_i64().unwrap(), json!([put(dev)]))).await.unwrap();
    assert_eq!(saved_now["outcome"], "saved");
    assert_eq!((saved_now["version"].clone(), saved_now["templates"].clone()), (json!(2), json!([{"id":"dev","label":"Dev","change":"change"}])));
    let list = saved(&ws);
    assert_eq!((list.version, list.templates[0].instructions.as_deref()), (2, Some("Write a test first.")));
    assert_eq!(list.templates[1].instructions.as_deref(), Some("Work as Review."), "the other template is as it was");

    let rows = history(&ws);
    assert_eq!(rows.len(), 2, "the user's first save and the lead's");
    assert_eq!((rows[0].0, rows[0].1.as_str(), rows[0].2.as_deref()), (1, "You", None));
    assert_eq!((rows[1].0, rows[1].1.as_str(), rows[1].2.as_deref()), (2, "Agent lead", Some("Say how to test")));
    assert_eq!(rows[1].3[0]["before"]["instructions"], "Work as Dev.");
    assert_eq!(rows[1].3[0]["after"]["instructions"], "Write a test first.");

    let mail = mail_to(&ws.store, "lead2");
    assert_eq!(mail, vec!["Agent lead changed the executor templates “Dev”; they are at version 2 now. Their reason: Say how to test".to_owned()]);
    assert!(mail_to(&ws.store, "lead").is_empty() && mail_to(&ws.store, "otherlead").is_empty(), "only the Project's other leads");

    let (_, view) = route(&ws, "GET", "/api/executor-templates", None).await;
    assert_eq!(view["lastModified"]["dev"]["by"], json!({"kind":"agent","id":"lead","name":"Agent lead"}));
    assert_eq!((view["lastModified"]["dev"]["reason"].clone(), view["lastModified"]["dev"]["version"].clone()), (json!("Say how to test"), json!(2)));
    assert_eq!(view["lastModified"]["review"]["by"], json!({"kind":"user","id":null,"name":"You"}));

    // A retry answers the same, and writes nothing more.
    let again = ws.collaboration_call(Some("lead"), TOOL, change("first", 1, json!([put(dev_with("Write a test first."))]))).await.unwrap();
    assert_eq!(again, saved_now);
    assert_eq!((saved(&ws).version, mail_to(&ws.store, "lead2").len()), (2, 1));
    let refused = error_of(ws.collaboration_call(Some("lead"), TOOL, change("first", 1, json!([put(dev_with("Other."))]))).await);
    assert!(refused.starts_with("idempotency_conflict:"), "{refused}");
}

/// Only a lead of a Project changes templates: not its executor, another
/// member, an Agent of no Project, or the user through the tool; nor a lead
/// of an archived Project.
#[tokio::test]
async fn only_a_lead_changes_templates() {
    let (_dir, ws, lab) = fixture().await;
    let input = change("r", 1, json!([put(dev_with("Push to main."))]));
    for agent in ["exec", "member", "outsider"] {
        let refused = error_of(ws.collaboration_call(Some(agent), TOOL, input.clone()).await);
        assert!(refused.starts_with("not_lead:"), "{agent}: {refused}");
    }
    assert!(error_of(ws.collaboration_call(None, TOOL, input.clone()).await).starts_with("agent_only:"));
    let archive = crate::projects::ProjectChange { name: None, key: None, default_dirs: Default::default(), archived: Some(true) };
    ws.store.update_project(&lab, archive).unwrap();
    let archived = error_of(ws.collaboration_call(Some("lead"), TOOL, input).await);
    assert!(archived.starts_with("project_archived:") || archived.starts_with("not_lead:"), "{archived}");
    assert_eq!((saved(&ws).version, history(&ws).len()), (1, 1), "nothing was written");
}

/// A change is checked as the user's save checks a template; a permission
/// raise is the lead's to make too, and the history keeps it.
#[tokio::test]
async fn a_change_is_checked_as_a_save_is() {
    let (_dir, ws, _) = fixture().await;
    let refused = |input: Value| {
        let ws = ws.clone();
        async move { error_of(ws.collaboration_call(Some("lead"), TOOL, input).await) }
    };
    assert!(refused(change("b", 1, json!([put(json!({"id":"dev","label":"Dev","harness":"claude","extra":1}))]))).await
        .contains("Unknown template field: extra"));
    assert!(refused(change("c", 1, json!([put(json!({"id":"dev","label":"Dev","harness":"other"}))]))).await.contains("harness is Codex"));
    assert!(refused(change("d", 1, json!([{"op":"remove","id":"gone"}]))).await.starts_with("unknown_template:"));
    assert!(refused(change("e", 1, json!([put(dev_with("x")), {"op":"remove","id":"dev"}]))).await.contains("named twice"));
    assert!(refused(change("f", 1, json!([put(dev_with("Work as Dev."))]))).await.starts_with("nothing_changed:"));
    assert!(refused(change("g", 1, json!([]))).await.starts_with("invalid_input: changes"));
    assert!(refused(json!({"requestId":"h","expectedVersion":1,"changes":[put(dev_with("x"))]})).await.starts_with("invalid_input: reason"));
    assert!(refused(change("i", 1, json!([{"op":"move","id":"dev"}]))).await.contains("put or remove"));
    assert!(refused(change("j", 5, json!([put(dev_with("x"))]))).await.starts_with("version_conflict: the executor templates are at version 1, not 5"));
    assert_eq!(saved(&ws).version, 1);

    // YN-56: a template that follows routing names no harness, and a level its harness doesn't keep is refused.
    assert!(refused(change("l", 1, json!([put(json!({"id":"dev","label":"Dev","harness":"claude"}))]))).await
        .contains("A template that follows routing names no harness"));
    assert!(refused(change("m", 1, json!([put(json!({"id":"dev","label":"Dev","harness":"claude","routing":"fixed","permissionLevel":"full"}))]))).await
        .contains("Claude Code doesn't keep the permission level full"));
    let raised = json!({"id":"review","label":"Review","harness":"codex","routing":"fixed","permissionLevel":"full"});
    ws.collaboration_call(Some("lead"), TOOL, change("k", 1, json!([put(raised)]))).await.unwrap();
    assert_eq!(saved(&ws).templates[1].permission_level.as_deref(), Some("full"));
    let rows = history(&ws);
    assert_eq!((rows[1].3[0]["before"]["permissionLevel"].clone(), rows[1].3[0]["after"]["permissionLevel"].clone()), (Value::Null, json!("full")));
}

/// A lead's change applies while each template it changes is as it was at
/// the version it read: the user's save of another template since doesn't
/// stop it; a change to one it changes does, naming who changed it. The
/// user's save over a lead's change gets the version conflict, naming it.
#[tokio::test]
async fn a_change_is_checked_against_each_template_it_changes() {
    let (_dir, ws, _) = fixture().await;
    // The user changes Review in Settings: version 2.
    let (status, _) = user_save(&ws, 1, json!([template("dev", "Dev", "claude"), json!({"id":"review","label":"Review","harness":"codex","routing":"fixed","instructions":"Mine."})])).await;
    assert_eq!(status, StatusCode::OK);
    // A lead that read version 1 changes Dev: it applies on version 2, Review kept as the user saved it.
    let applied = ws.collaboration_call(Some("lead"), TOOL, change("dev", 1, json!([put(dev_with("Dev, changed."))]))).await.unwrap();
    assert_eq!(applied["version"], 3);
    let list = saved(&ws);
    assert_eq!((list.templates[0].instructions.as_deref(), list.templates[1].instructions.as_deref()), (Some("Dev, changed."), Some("Mine.")));
    // Another lead that read version 1 changes Review: the user changed it since.
    let refused = error_of(ws.collaboration_call(Some("otherlead"), TOOL, change("review", 1,
        json!([put(json!({"id":"review","label":"Review","harness":"codex","routing":"fixed","instructions":"Theirs."}))]))).await);
    assert_eq!(refused, "version_conflict: You changed “Review” at version 2 after version 1; read the templates again and change them on version 3");
    // An addition another save made since is a conflict too.
    ws.collaboration_call(Some("lead"), TOOL, change("add", 3, json!([put(template("docs", "Docs", "claude"))]))).await.unwrap();
    let refused = error_of(ws.collaboration_call(Some("otherlead"), TOOL, change("add2", 3, json!([put(template("docs", "Docs 2", "claude"))]))).await);
    assert!(refused.starts_with("version_conflict: Agent lead changed “Docs” at version 4"), "{refused}");

    // The user's page read version 2; leads saved 3 and 4.
    let (status, conflict) = user_save(&ws, 2, json!([template("dev", "Dev", "claude")])).await;
    assert!(status.is_client_error(), "{conflict}");
    assert!(conflict.to_string().contains("version_conflict: Agent lead changed “Dev”; Agent lead changed “Docs” after you read the templates; reload before saving"),
        "{conflict}");
}

/// A save this history doesn't have, an older Core's, is a conflict for
/// the whole list, until the lead reads the list again.
#[tokio::test]
async fn a_save_without_history_is_a_conflict_for_the_whole_list() {
    let (_dir, ws, _) = fixture().await;
    let list = saved(&ws);
    let raw = list.stored_templates();
    ws.store.db.write().unwrap().execute("UPDATE workspace_meta SET value=?1 WHERE key=?2",
        params![json!({"version": 2, "templates": raw}).to_string(), KEY]).unwrap();
    let refused = error_of(ws.collaboration_call(Some("lead"), TOOL, change("a", 1, json!([put(dev_with("x"))]))).await);
    assert!(refused.starts_with("version_conflict: the executor templates are at version 2, not 1"), "{refused}");
    ws.collaboration_call(Some("lead"), TOOL, change("b", 2, json!([put(dev_with("x"))]))).await.unwrap();
    assert_eq!(saved(&ws).version, 3);
}

/// A change adds and removes templates; an added one is last.
#[tokio::test]
async fn a_change_adds_and_removes_templates() {
    let (_dir, ws, _) = fixture().await;
    let answer = ws.collaboration_call(Some("lead"), TOOL, change("r", 1, json!([
        {"op":"remove","id":"review"}, put(template("docs", "Docs", "claude"))]))).await.unwrap();
    assert_eq!(answer["templates"], json!([{"id":"docs","label":"Docs","change":"add"},{"id":"review","label":"Review","change":"remove"}]));
    let ids: Vec<String> = saved(&ws).templates.into_iter().map(|t| t.id).collect();
    assert_eq!(ids, ["dev", "docs"]);
}

/// A lead reads the templates whole with `full`, each as saved, to send one
/// back changed; an executor, another member or an Agent of no Project
/// can't, and lists them without their instructions.
#[tokio::test]
async fn only_a_lead_reads_the_templates_whole() {
    let (_dir, ws, _) = fixture().await;
    let list = crate::executor_templates::LIST_TOOL;
    let full = ws.collaboration_call(Some("lead"), list, json!({"full":true})).await.unwrap();
    let stored = saved(&ws).stored_templates();
    assert_eq!((full["templates"][0]["template"].clone(), full["templates"][1]["template"].clone()), (stored[0].clone(), stored[1].clone()));
    assert_eq!(full["templates"][0]["template"]["instructions"], "Work as Dev.");
    assert_eq!(full["templates"][0]["instructionsBytes"], "Work as Dev.".len(), "the listed fields stay");
    for agent in ["exec", "member", "outsider"] {
        let refused = error_of(ws.collaboration_call(Some(agent), list, json!({"full":true})).await);
        assert!(refused.starts_with("not_lead: only a lead of a Project reads the templates whole"), "{agent}: {refused}");
        let listed = ws.collaboration_call(Some(agent), list, json!({})).await.unwrap();
        assert!(listed["templates"][0].get("template").is_none() && !listed.to_string().contains("Work as Dev."), "{agent}: {listed}");
    }
    let wrong = error_of(ws.collaboration_call(Some("lead"), list, json!({"full":"yes"})).await);
    assert_eq!(wrong, "invalid_input: full is true or false");
}

/// The tool is in every Agent's list, its description whole in every
/// supported client.
#[test]
fn the_tool_is_listed_within_the_description_limit() {
    let tool = crate::collaboration_store::tool_definitions().into_iter().find(|t| t["name"] == TOOL).unwrap();
    let units = tool["description"].as_str().unwrap().encode_utf16().count();
    assert!(units <= crate::results::max_description_length(), "{units}");
    let _: rmcp::model::Tool = serde_json::from_value(tool).unwrap();
}
