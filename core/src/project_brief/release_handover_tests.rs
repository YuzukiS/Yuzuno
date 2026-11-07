use super::*;

/// T-36 S2: an executor's release hands its live Asks and sections to the
/// Agent that dispatched it, as a claim: Home's reply goes there, also from
/// a Home that still showed the executor as the owner, and the dispatcher
/// resolves it.
#[tokio::test]
async fn a_released_executors_ask_is_its_dispatchers_to_answer_and_resolve() {
    let (_dir, ws, project) = lab();
    // c is an executor here, so it doesn't lead the Project.
    set_leads(&ws, &project, &["a", "b"]);
    ws.store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,project_id,template_id,created_by,created_at,updated_at)
         VALUES('c','executor',?1,'reviewer','agent:a','now','now')", [&project]).unwrap();
    accept(&ws, "c", input("ask", 0, vec![put("question", "ask")])).await;
    let released = ws.release_executor(Some("a"), "c").await.unwrap();
    assert!(released["releasedAt"].is_string(), "{released}");
    let row = sections::find(&ws.store.db.read().unwrap(), &project, "question", None).unwrap().unwrap();
    assert_eq!((row.owner_id.as_str(), row.owner_name.as_str(), row.live), ("a", "Agent a", true), "the Ask is the dispatcher's now");
    let workspace = ws.store.workspace_id().unwrap();
    // A Home that still showed the executor as the owner.
    let reply = home::ReplyInput { key: Some("question".into()), agent_id: "c".into(), text: String::new(), client_message_id: "r1".into(),
        choice: Some("left".into()), version: None, title: None, ask_version: Some(1), workspace_id: Some(workspace), form: None };
    home::reply(&ws, project.clone(), reply).await.unwrap_or_else(|error| panic!("the reply goes to the dispatcher: {error}"));
    assert!(ws.store.receipt("a", "r1").unwrap().is_some(), "the reply reaches the dispatcher");
    assert!(ws.store.receipt("c", "r1").unwrap().is_none(), "not the released executor");
    // Delivered to a runtime, the reply marks the Ask replied (the lab check
    // shows that with one); here no runtime runs, so it is marked as other
    // tests mark it.
    assert!(sections::mark_replied_live(&ws.store, &project, "question", "Left").unwrap());
    accept(&ws, "a", input("resolve", version(&ws, &project), vec![op("resolve", "question")])).await;
    assert!(sections::find(&ws.store.db.read().unwrap(), &project, "question", None).unwrap().is_none_or(|row| !row.live),
        "the dispatcher resolved it");
}

/// T-36 S2 (#635 R1 2f82a185): a closed dispatcher can't answer, so an
/// executor's archive hands it nothing. Its Ask stays orphaned, and a Home
/// reply to it is refused rather than sent to the closed Agent, until an
/// editor claims it. Its undecided proposal is mailed to no one: the user
/// decides it. An open dispatcher's executor is handed over as before.
#[tokio::test]
async fn a_closed_dispatcher_is_handed_nothing_and_an_open_one_both() {
    let (_dir, ws, project) = lab();
    // b and c are executors here, so they don't lead the Project.
    set_leads(&ws, &project, &["a"]);
    // b was dispatched by a, which stays open; c by d, closed before c's release.
    for (executor, by) in [("b", "agent:a"), ("c", "agent:d")] {
        ws.store.db.write().unwrap().execute(
            "INSERT INTO agent_roles(agent_id,kind,project_id,template_id,created_by,created_at,updated_at)
             VALUES(?1,'executor',?2,'reviewer',?3,'now','now')", params![executor, project, by]).unwrap();
        accept(&ws, executor, input(executor, version(&ws, &project), vec![put(&format!("{executor}-ask"), "ask")])).await;
        let spec = json!({"root":"r","elements":{"r":{"type":"Result","props":{"title":"Status","summary":"Done here."},"children":["p"]},
            "p":{"type":"TaskStatus","props":{"taskId":"T-1","status":"review","reason":"Ready"}}}}).to_string();
        ws.store.db.write().unwrap().execute(
            "INSERT INTO interactive_results(id,chain_id,version,agent_id,session_id,turn_id,request_id,schema_version,spec_json,defaults_json,raw_json,created_at)
             VALUES(?1,?1,1,?2,'session','t1',?1,2,?3,'[]',?3,'now')", params![format!("{executor}-proposal"), executor, spec]).unwrap();
    }
    close(&ws, "d", true);
    ws.release_executor(Some("a"), "b").await.unwrap();
    ws.release_executor(None, "c").await.unwrap();
    let owner = |key: &str| {
        let row = sections::find(&ws.store.db.read().unwrap(), &project, key, None).unwrap().unwrap();
        (row.owner_id, row.live)
    };
    assert_eq!(owner("b-ask"), ("a".to_owned(), true), "an open dispatcher is handed the Ask");
    assert_eq!(owner("c-ask"), ("c".to_owned(), true), "a closed dispatcher is handed nothing: the Ask stays orphaned");
    let proposals = |agent: &str| -> Vec<String> {
        let db = ws.store.db.read().unwrap();
        let mut query = db.prepare("SELECT json_extract(data,'$.metadata.resultId') FROM collaboration_messages
            WHERE recipient_id=?1 AND json_extract(data,'$.metadata.kind')='executor_proposal'").unwrap();
        let ids = query.query_map([agent], |r| r.get(0)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
        ids
    };
    assert_eq!(proposals("a"), vec!["b-proposal".to_owned()], "an open dispatcher is told of the proposal its executor left");
    assert!(proposals("d").is_empty(), "a closed dispatcher is mailed nothing");
    // A Home that still showed c as the owner.
    let workspace = ws.store.workspace_id().unwrap();
    let reply = |id: &str, shown: i64| home::ReplyInput { key: Some("c-ask".into()), agent_id: "c".into(), text: String::new(),
        client_message_id: id.into(), choice: Some("left".into()), version: None, title: None, ask_version: Some(shown),
        workspace_id: Some(workspace.clone()), form: None };
    let refused = home::reply(&ws, project.clone(), reply("r1", 1)).await.is_err();
    assert!(refused, "a reply no open Agent owns is refused");
    assert!(ws.store.receipt("d", "r1").unwrap().is_none() && ws.store.receipt("c", "r1").unwrap().is_none(), "and goes nowhere");
    accept(&ws, "a", input("claim", version(&ws, &project), vec![op("claim", "c-ask")])).await;
    let shown = sections::find(&ws.store.db.read().unwrap(), &project, "c-ask", None).unwrap().unwrap().version;
    home::reply(&ws, project.clone(), reply("r2", shown)).await.unwrap_or_else(|error| panic!("once claimed, the reply goes to the editor: {error}"));
    assert!(ws.store.receipt("a", "r2").unwrap().is_some(), "the editor that claimed it has the reply");
}
