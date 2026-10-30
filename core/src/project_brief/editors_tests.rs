use super::*;

#[tokio::test]
async fn policy_limits_every_operation_without_bypassing_section_ownership() {
    let (_dir, ws, project) = lab();
    accept(&ws, "b", input("old", 0, vec![put("old", "status")])).await;
    accept(&ws, "c", input("orphan", 1, vec![put("orphan", "report")])).await;
    close(&ws, "c", true);
    editors::save(&ws.store, &project, 0, Some(vec!["a".into()])).unwrap();
    let capabilities = brief(&ws, "b")["you"]["capabilities"].clone();
    assert_eq!(capabilities, json!({"editContent":false,"requiresTurnUpdate":false,"writeOwnAsk":true}));
    assert_eq!(brief(&ws, "a")["you"]["capabilities"]["editContent"], true);
    // A mixed request is atomic; regular creates, edits, removes, claims and
    // regular-to-Ask conversions are all refused before changing anything.
    for (n, changes) in [vec![put("new", "report")], vec![put("old", "status")],
        vec![op("remove", "old")], vec![op("claim", "orphan")], vec![put("old", "ask")],
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
    // A caller cannot smuggle the user setting into an Agent update.
    let mut self_grant = input("grant", 6, vec![put("forbidden", "report")]);
    self_grant["editorAgentIds"] = json!(["b"]);
    assert!(codes(&reject(&ws, "b", self_grant).await).contains(&"invalid_input".into()));
}

#[tokio::test]
async fn home_filters_sources_without_seen_and_keeps_asks_approvals_and_totals() {
    let (_dir, ws, project) = lab();
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
    editors::save(&ws.store, &project, 0, Some(vec!["a".into()])).unwrap();
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
    // Clearing the list hides every regular source; both Asks survive.
    editors::save(&ws.store, &project, 1, Some(vec![])).unwrap();
    let empty = home::build(&ws.store).unwrap();
    assert_eq!(empty["projects"][0]["brief"]["sections"].as_array().unwrap().len(), 2);
    assert_eq!(empty["projects"][0]["unseen"], 2);
    assert_eq!(empty["projects"][0]["missing"], json!([]));
    assert_eq!(rows(&ws, "SELECT count(*) FROM project_brief_seen"), 0);
    // Restoring compatibility reveals the exact original content, unread.
    editors::save(&ws.store, &project, 2, None).unwrap();
    let restored = home::build(&ws.store).unwrap();
    assert_eq!(restored["projects"][0]["brief"]["sections"], before["projects"][0]["brief"]["sections"]);
}

#[test]
fn editor_policy_is_project_scoped_persistent_and_explicit_empty_is_not_default() {
    let (dir, ws, project) = lab();
    assert_eq!(editors::get(&ws.store, &project).unwrap().editor_agent_ids, None);
    assert_eq!(agent_edits_brief(&ws.store, "b").unwrap(), Some(project.clone()));
    let other = ws.store.create_project("Other", BTreeMap::new()).unwrap().id;
    ws.store.set_agent_project("d", Some(&other)).unwrap();
    assert!(editors::save(&ws.store, &project, 0, Some(vec!["d".into()])).is_err());
    assert!(editors::save(&ws.store, &project, 0, Some(vec!["a".into(), "a".into()])).is_err());
    editors::save(&ws.store, &project, 0, Some(vec![])).unwrap();
    assert_eq!(agent_edits_brief(&ws.store, "a").unwrap(), None);
    assert_eq!(agent_edits_brief(&ws.store, "d").unwrap(), Some(other.clone()));
    ws.store.insert(&agent("new")).unwrap();
    ws.store.set_agent_project("new", Some(&project)).unwrap();
    assert_eq!(agent_edits_brief(&ws.store, "new").unwrap(), None);
    assert!(editors::save(&ws.store, &project, 0, None).is_err(), "stale settings must not overwrite");
    editors::save(&ws.store, &project, 1, Some(vec!["a".into()])).unwrap();
    close(&ws, "a", true);
    assert_eq!(agent_edits_brief(&ws.store, "a").unwrap(), None);
    assert!(editors::save(&ws.store, &project, 2, Some(vec!["a".into()])).is_err());
    close(&ws, "a", false);
    ws.store.set_agent_project("a", Some(&other)).unwrap();
    assert!(!editors::can_edit(&ws.store, &ws.store.db.read().unwrap(), &project, "a").unwrap());
    assert_eq!(get(&ws.store, Some("a"), &json!({"projectId":project})).unwrap()["you"]["capabilities"]["writeOwnAsk"], false);
    drop(ws);
    let reopened = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    assert_eq!(editors::get(&reopened.store, &project).unwrap().editor_agent_ids, Some(vec!["a".into()]));
    assert_eq!(agent_edits_brief(&reopened.store, "new").unwrap(), None);
}
