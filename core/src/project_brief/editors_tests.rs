use super::*;

/// The user's choice of leads, as the Project's settings save it, against
/// the version it read. Set here so each test says who leads.
fn choose_leads(ws: &Workspace, project: &str, ids: &[&str]) {
    let version = crate::agent_roles::get(&ws.store, project).unwrap().version;
    crate::agent_roles::save(&ws.store, project, version, ids.iter().map(|id| id.to_string()).collect()).unwrap();
}

fn edits(ws: &Workspace, actor: &str) -> Value {
    brief(ws, actor)["you"]["capabilities"]["editContent"].clone()
}

/// YN-2 S4: a lead edits Home, even where the list an older Core kept
/// (`project_brief_editors`) left it out; that list is no longer read.
#[test]
fn a_lead_edits_home_even_where_an_old_list_left_it_out() {
    let (_dir, ws, project) = lab();
    choose_leads(&ws, &project, &["a"]);
    ws.store.db.write().unwrap().execute(
        "INSERT OR REPLACE INTO project_brief_editors(project_id,version,editor_ids) VALUES(?1,3,'[\"b\"]')", [&project]).unwrap();
    assert_eq!(edits(&ws, "a"), true, "a lead edits Home even where an old list left it out");
    assert_eq!(edits(&ws, "b"), false, "an old list's editor that is not a lead is Ask-only");
    assert_eq!(agent_edits_brief(&ws.store, "a").unwrap(), Some(project.clone()));
    assert_eq!(brief(&ws, "a")["contentEditors"], json!({"version":crate::agent_roles::get(&ws.store, &project).unwrap().version,
        "editorAgentIds":["a"],"rule":"leads"}), "contentEditors names the leads");
}

/// YN-2 S4: a member that is not a lead is Ask-only, also where no list
/// was ever saved (before S4 every member but an executor edited then).
#[tokio::test]
async fn a_member_that_is_not_a_lead_is_ask_only_with_no_list_saved() {
    let (_dir, ws, project) = lab();
    choose_leads(&ws, &project, &["a"]);
    let saved: i64 = ws.store.db.read().unwrap().query_row(
        "SELECT COUNT(*) FROM project_brief_editors WHERE project_id=?1", [&project], |r| r.get(0)).unwrap();
    assert_eq!(saved, 0, "no Home editor list is saved");
    assert_eq!(brief(&ws, "b")["you"]["capabilities"], json!({"editContent":false,"requiresTurnUpdate":false,"writeOwnAsk":true}),
        "a member that is not a lead is Ask-only with no list saved");
    assert!(codes(&reject(&ws, "b", input("report", 0, vec![put("news", "report")])).await).contains(&"ask_only".into()));
    accept(&ws, "b", input("ask", 0, vec![put("question", "ask")])).await;
    accept(&ws, "a", input("lead", 1, vec![put("plan", "status")])).await;
}

/// YN-2 S4: with no lead, the Project has no Home editor: every member
/// asks. (The user's rule makes the Agents they create leads, so this is a
/// Project whose leads the user removed.)
#[test]
fn a_project_with_no_lead_has_no_home_editor() {
    let (_dir, ws, project) = lab();
    choose_leads(&ws, &project, &[]);
    for agent in ["a", "b", "c"] {
        assert_eq!(edits(&ws, agent), false, "{agent}: a Project with no lead has no Home editor");
        assert_eq!(agent_edits_brief(&ws.store, agent).unwrap(), None);
    }
    assert_eq!(brief(&ws, "a")["contentEditors"]["editorAgentIds"], json!([]));
}

/// YN-2 S4: the separate Home editors setting is gone. A save from an older
/// page is refused, whatever it sends, and the list an older Core kept stays
/// as it was; a read answers the leads.
#[tokio::test]
async fn the_home_editors_save_is_refused_and_the_stored_list_is_kept() {
    let (_dir, ws, project) = lab();
    choose_leads(&ws, &project, &["a"]);
    ws.store.db.write().unwrap().execute(
        "INSERT OR REPLACE INTO project_brief_editors(project_id,version,editor_ids) VALUES(?1,4,'[\"b\"]')", [&project]).unwrap();
    let call = |method: &'static str, body: Option<Value>| {
        let ws = ws.clone();
        let path = format!("/api/projects/{project}/home-editors");
        async move {
            let mut request = axum::http::Request::builder().method(method).uri(path);
            if body.is_some() {
                request = request.header("content-type", "application/json");
            }
            let request = request.body(body.map_or_else(axum::body::Body::empty, |b| axum::body::Body::from(b.to_string()))).unwrap();
            let response = tower::ServiceExt::oneshot(http::routes().with_state(ws), request).await.unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null))
        }
    };
    for body in [json!({"expectedVersion":4,"editorAgentIds":["b","c"]}), json!({"expectedVersion":4,"editorAgentIds":null})] {
        let (status, refused) = call("PUT", Some(body)).await;
        assert!(!status.is_success() && refused["error"].as_str().is_some_and(|e| e.starts_with("setting_removed: Home editors are the Project's leads")),
            "the Home editors save is refused: {status} {refused}");
    }
    let kept: (i64, String) = ws.store.db.read().unwrap().query_row(
        "SELECT version,editor_ids FROM project_brief_editors WHERE project_id=?1", [&project], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
    assert_eq!(kept, (4, "[\"b\"]".to_owned()), "the stored list is kept as it was");
    let (status, read) = call("GET", None).await;
    assert_eq!((status.is_success(), read["editorAgentIds"].clone(), read["rule"].clone()), (true, json!(["a"]), json!("leads")), "{read}");
    assert_eq!(edits(&ws, "b"), false);
}

/// YN-2 S4 (Q-L5): an Ask-only owner may take down a report or status it
/// wrote while it edited Home; it still can't write one again or remove
/// another's. (The old list says the same here, so the rule is the S4 one
/// whichever list a Core reads.)
#[tokio::test]
async fn an_ask_only_owner_removes_its_own_old_status() {
    let (_dir, ws, project) = lab();
    choose_leads(&ws, &project, &["a", "b"]);
    accept(&ws, "b", input("old", 0, vec![put("plan", "status"), put("notes", "report")])).await;
    accept(&ws, "a", input("other", 1, vec![put("summary", "report")])).await;
    choose_leads(&ws, &project, &["a"]);
    ws.store.db.write().unwrap().execute(
        "INSERT OR REPLACE INTO project_brief_editors(project_id,version,editor_ids) VALUES(?1,1,'[\"a\"]')", [&project]).unwrap();
    assert_eq!(edits(&ws, "b"), false);
    let removed = call(&ws, "b", input("down", 2, vec![op("remove", "plan")])).await.unwrap();
    assert!(removed.is_ok(), "an Ask-only owner removes its own old status: {removed:?}");
    assert!(section(&brief(&ws, "a"), "plan").is_null());
    assert!(codes(&reject(&ws, "b", input("again", 3, vec![put("plan", "status")])).await).contains(&"ask_only".into()),
        "it can't write a status again");
    assert!(!codes(&reject(&ws, "b", input("theirs", 3, vec![op("remove", "summary")])).await).is_empty(),
        "nor remove another's");
    accept(&ws, "b", input("down2", 3, vec![op("remove", "notes")])).await;
    assert!(!section(&brief(&ws, "a"), "summary").is_null());
}

#[tokio::test]
async fn policy_limits_every_operation_without_bypassing_section_ownership() {
    let (_dir, ws, project) = lab();
    choose_leads(&ws, &project, &["a", "b", "c"]);
    accept(&ws, "b", input("old", 0, vec![put("old", "status")])).await;
    accept(&ws, "c", input("orphan", 1, vec![put("orphan", "report")])).await;
    close(&ws, "c", true);
    choose_leads(&ws, &project, &["a"]);
    let capabilities = brief(&ws, "b")["you"]["capabilities"].clone();
    assert_eq!(capabilities, json!({"editContent":false,"requiresTurnUpdate":false,"writeOwnAsk":true}));
    assert_eq!(brief(&ws, "a")["you"]["capabilities"]["editContent"], true);
    // A mixed request is atomic; regular creates, edits, claims and
    // regular-to-Ask conversions are all refused before changing anything.
    for (n, changes) in [vec![put("new", "report")], vec![put("old", "status")],
        vec![op("claim", "orphan")], vec![put("old", "ask")],
        vec![put("fine", "ask"), put("bad", "status")]].into_iter().enumerate() {
        let before = rows(&ws, "SELECT count(*) FROM project_brief_receipts");
        let rejected = reject(&ws, "b", input(&format!("bad{n}"), 2, changes)).await;
        assert!(codes(&rejected).contains(&"ask_only".into()), "{rejected}");
        assert_eq!(version(&ws, &project), 2);
        assert_eq!(rows(&ws, "SELECT count(*) FROM project_brief_receipts"), before);
        assert!(section(&brief(&ws, "b"), "fine").is_null());
    }
    assert!(codes(&reject(&ws, "a", input("other-owner", 2, vec![put("old", "status")])).await).contains(&"not_owner".into()));
    accept(&ws, "a", input("editor", 2, vec![put("summary", "status")])).await;
    accept(&ws, "b", input("ask", 3, vec![put("summary/question", "ask")])).await;
    assert!(sections::mark_replied_live(&ws.store, &project, "summary/question", "Left").unwrap());
    assert_eq!(section(&brief(&ws, "b"), "summary/question")["ask"]["state"], "replied");
    accept(&ws, "b", input("ask-edit", 4, vec![put("summary/question", "ask")])).await;
    assert!(codes(&reject(&ws, "b", input("ask-convert", 5, vec![put("summary/question", "report")])).await).contains(&"ask_only".into()));
    assert!(sections::mark_replied_live(&ws.store, &project, "summary/question", "Left").unwrap());
    accept(&ws, "b", input("resolved", 5, vec![op("resolve", "summary/question")])).await;
    // Optional noChange is still a normal accepted, turn-bound receipt.
    running(&ws, "b", "t2");
    let quiet = accept(&ws, "b", json!({"requestId":"quiet","expectedVersion":6,"noChange":true})).await;
    assert_eq!(quiet["receipt"]["kind"], "noChange");
    assert_eq!(turn_receipt(&ws.store, "b", "t2").unwrap().as_deref(), Some("noChange"));
    // A caller cannot smuggle a lead choice into an Agent update.
    let mut self_grant = input("grant", 6, vec![put("forbidden", "report")]);
    self_grant["editorAgentIds"] = json!(["b"]);
    assert!(codes(&reject(&ws, "b", self_grant).await).contains(&"invalid_input".into()));
}

#[tokio::test]
async fn home_filters_sources_without_seen_and_keeps_asks_approvals_and_totals() {
    let (_dir, ws, project) = lab();
    choose_leads(&ws, &project, &["a", "b", "c"]);
    accept(&ws, "a", input("lead", 0, vec![put("lead", "status")])).await;
    accept(&ws, "b", input("worker", 1, vec![put("worker", "report"), put("worker/question", "ask")])).await;
    // A replied Ask stays live too, even when its author is Ask-only.
    accept(&ws, "b", input("second", 2, vec![put("reply", "ask")])).await;
    sections::mark_replied_live(&ws.store, &project, "reply", "Left").unwrap();
    record_turn_outcome(&ws.store, "b", "missed", &project, "missing").unwrap();
    record_turn_outcome(&ws.store, "a", "missed", &project, "missing").unwrap();
    // Hidden outcomes must not exhaust the visible editor's 50-row window.
    for n in 0..51 {
        record_turn_outcome(&ws.store, "b", &format!("hidden-{n}"), &project, "missing").unwrap();
    }
    let before = home::build(&ws.store).unwrap();
    assert_eq!(before["projects"][0]["unseen"], 4);
    choose_leads(&ws, &project, &["a"]);
    let view = home::build(&ws.store).unwrap();
    let panel = &view["projects"][0];
    let keys: Vec<_> = panel["brief"]["sections"].as_array().unwrap().iter().map(|s| s["key"].clone()).collect();
    assert_eq!(keys, vec![json!("lead"), json!("worker/question"), json!("reply")]);
    assert_eq!(panel["brief"]["teamSections"][0]["key"], "worker");
    assert!(panel["brief"]["teamSections"][0]["seen"].is_null());
    assert_eq!(panel["unseen"], 3);
    assert_eq!(panel["missing"].as_array().unwrap().len(), 1);
    assert_eq!(panel["missing"][0]["agentId"], "a");
    assert_eq!(panel["agents"], before["projects"][0]["agents"]);
    assert_eq!(view["needsYou"][0]["sectionKey"], "worker/question");
    // With no lead every regular source is hidden; both Asks survive.
    choose_leads(&ws, &project, &[]);
    let empty = home::build(&ws.store).unwrap();
    assert_eq!(empty["projects"][0]["brief"]["sections"].as_array().unwrap().len(), 2);
    assert_eq!(empty["projects"][0]["unseen"], 2);
    assert_eq!(empty["projects"][0]["missing"], json!([]));
    assert_eq!(rows(&ws, "SELECT count(*) FROM project_brief_seen"), 0);
    // The same leads again show the exact original content, unread.
    choose_leads(&ws, &project, &["a", "b", "c"]);
    let restored = home::build(&ws.store).unwrap();
    assert_eq!(restored["projects"][0]["brief"]["sections"], before["projects"][0]["brief"]["sections"]);
}

#[test]
fn home_editors_are_project_scoped_and_persistent() {
    let (dir, ws, project) = lab();
    choose_leads(&ws, &project, &["a", "b"]);
    assert_eq!(agent_edits_brief(&ws.store, "b").unwrap(), Some(project.clone()));
    let other = ws.store.create_project("Other", BTreeMap::new()).unwrap().id;
    ws.store.set_agent_project("d", Some(&other)).unwrap();
    choose_leads(&ws, &other, &["d"]);
    choose_leads(&ws, &project, &[]);
    assert_eq!(agent_edits_brief(&ws.store, "a").unwrap(), None);
    assert_eq!(agent_edits_brief(&ws.store, "d").unwrap(), Some(other.clone()));
    ws.store.insert(&agent("new")).unwrap();
    ws.store.set_agent_project("new", Some(&project)).unwrap();
    assert_eq!(agent_edits_brief(&ws.store, "new").unwrap(), None, "a member that is not a lead does not edit");
    choose_leads(&ws, &project, &["a"]);
    close(&ws, "a", true);
    assert_eq!(agent_edits_brief(&ws.store, "a").unwrap(), None, "a closed lead does not edit");
    close(&ws, "a", false);
    ws.store.set_agent_project("a", Some(&other)).unwrap();
    assert!(!editors::can_edit(&ws.store, &ws.store.db.read().unwrap(), &project, "a").unwrap());
    assert!(!editors::can_edit(&ws.store, &ws.store.db.read().unwrap(), &other, "a").unwrap(), "a lead leads only the Project it was chosen for");
    assert_eq!(get(&ws.store, Some("a"), &json!({"projectId":project})).unwrap()["you"]["capabilities"]["writeOwnAsk"], false);
    ws.store.set_agent_project("a", Some(&project)).unwrap();
    choose_leads(&ws, &project, &["a"]);
    drop(ws);
    let reopened = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    assert_eq!(json!(editors::get(&reopened.store, &project).unwrap().editor_agent_ids), json!(["a"]));
    assert_eq!(agent_edits_brief(&reopened.store, "new").unwrap(), None);
}

/// T-36, YN-2 S4: a task executor is never a Home editor: it can't lead, and
/// a list an older Core kept that names it does not make it one. It still
/// asks its own questions, and Home shows what it wrote before as the team's.
#[tokio::test]
async fn a_task_executor_is_never_a_home_editor_with_no_list_or_one() {
    let (_dir, ws, project) = lab();
    choose_leads(&ws, &project, &["a", "b", "c"]);
    accept(&ws, "c", input("before", 0, vec![put("written", "report")])).await;
    choose_leads(&ws, &project, &["a", "b"]);
    ws.store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,project_id,template_id,created_by,created_at,updated_at)
         VALUES('c','executor',?1,'reviewer','agent:a','now','now')", [&project]).unwrap();
    let ask_only = json!({"editContent":false,"requiresTurnUpdate":false,"writeOwnAsk":true});
    assert_eq!(brief(&ws, "c")["you"]["capabilities"], ask_only);
    assert_eq!(brief(&ws, "b")["you"]["capabilities"]["editContent"], true);
    assert!(codes(&reject(&ws, "c", input("after", 1, vec![put("new", "report")])).await).contains(&"ask_only".into()));
    accept(&ws, "c", input("ask", 1, vec![put("question", "ask")])).await;
    let shown = |ws: &Workspace| {
        let view = home::build(&ws.store).unwrap();
        let keys = |list: &Value| list.as_array().unwrap().iter().map(|s| s["key"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
        (keys(&view["projects"][0]["brief"]["sections"]), keys(&view["projects"][0]["brief"]["teamSections"]))
    };
    assert_eq!(shown(&ws), (vec!["question".to_owned()], vec!["written".to_owned()]), "its Ask is the Project's, its report the team's");
    let version = crate::agent_roles::get(&ws.store, &project).unwrap().version;
    let refused = crate::agent_roles::save(&ws.store, &project, version, vec!["b".into(), "c".into()]).unwrap_err().to_string();
    assert!(refused.starts_with("invalid_lead: an executor cannot lead a Project"), "{refused}");
    ws.store.db.write().unwrap().execute(
        "INSERT INTO project_brief_editors(project_id,version,editor_ids) VALUES(?1,1,'[\"b\",\"c\"]')", [&project]).unwrap();
    assert_eq!(brief(&ws, "c")["you"]["capabilities"], ask_only, "a list that names it does not make it an editor");
    assert_eq!(brief(&ws, "b")["you"]["capabilities"]["editContent"], true);
    assert_eq!(shown(&ws), (vec!["question".to_owned()], vec!["written".to_owned()]));
}
