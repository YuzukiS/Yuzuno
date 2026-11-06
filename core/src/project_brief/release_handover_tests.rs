use super::*;

/// T-36 S2: an executor's release hands its live Asks and sections to the
/// Agent that dispatched it, as a claim: Home's reply goes there, also from
/// a Home that still showed the executor as the owner, and the dispatcher
/// resolves it.
#[tokio::test]
async fn a_released_executors_ask_is_its_dispatchers_to_answer_and_resolve() {
    let (_dir, ws, project) = lab();
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
    let row = sections::find(&ws.store.db.read().unwrap(), &project, "question", None).unwrap().unwrap();
    assert_eq!(row.ask_state.as_deref(), Some("replied"), "the Ask is replied");
    accept(&ws, "a", input("resolve", version(&ws, &project), vec![op("resolve", "question")])).await;
    assert!(sections::find(&ws.store.db.read().unwrap(), &project, "question", None).unwrap().is_none_or(|row| !row.live),
        "the dispatcher resolved it");
}
