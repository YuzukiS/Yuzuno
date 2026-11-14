//! YN-86 S2a: a section bound to a task, its responsible Agent, the
//! executor's sub-topics under its card, the card's end with its task, and
//! where a reply to it goes.
use super::*;
use crate::executor_lifecycle::tests::role;

/// A task of `project` (its public key) and its internal ID.
fn task_in(ws: &Workspace, project: &str, title: &str) -> (String, String) {
    let created = ws.store.collaboration_call(None, "task_create",
        json!({"requestId":format!("create {title}"),"title":title,"projectId":project,"status":"doing"})).unwrap();
    let public = created["task"]["id"].as_str().unwrap().to_owned();
    let internal = crate::collaboration_store::task_key(&ws.store.db.read().unwrap(), &public).unwrap().0;
    (public, internal)
}

/// The user's change to a task, at the version it has now.
fn task_set(ws: &Workspace, task: &str, patch: Value) -> Value {
    let version: i64 = {
        let db = ws.store.db.read().unwrap();
        let (internal, _) = crate::collaboration_store::task_key(&db, task).unwrap();
        db.query_row("SELECT version FROM collaboration_tasks WHERE id=?1", [internal], |r| r.get(0)).unwrap()
    };
    let request = format!("set {task} {patch}");
    ws.store.collaboration_call(None, "task_update", json!({"requestId":request,"taskId":task,"expectedVersion":version,"patch":patch})).unwrap()
}

fn bound(key: &str, kind: &str, task: &str) -> Value {
    let mut change = put(key, kind);
    change["task"] = json!(task);
    change
}

fn card<'a>(brief: &'a Value, key: &str) -> &'a Value {
    &section(brief, key)["card"]
}

fn panel(ws: &Workspace) -> Value {
    home::build(&ws.store).unwrap()["projects"][0].clone()
}

fn keys(panel: &Value, part: &str) -> Vec<String> {
    panel["brief"][part].as_array().unwrap().iter().map(|s| s["key"].as_str().unwrap().to_owned()).collect()
}

/// Each key's row: live, and why it is history.
fn row(ws: &Workspace, project: &str, key: &str) -> (bool, Option<String>) {
    let row = sections::find(&ws.store.db.read().unwrap(), project, key, None).unwrap().expect("kept");
    (row.live, row.history_reason)
}

fn open(ws: &Workspace, project: &str, key: &str) -> Value {
    let row = sections::live_key(&ws.store.db.read().unwrap(), project, key).unwrap().expect("a live section");
    let shown = sections::Opened { workspace_id: ws.store.workspace_id().unwrap(), section_id: row.identity, key: key.into(), version: row.version };
    sections::mark_opened(&ws.store, project, &shown).unwrap()
}

/// A lead binds a section to a task of its own Project that is not archived
/// (put or edit, with task alone), keeps it through a put without task, and
/// unbinds it with null. Another Project's task, an archived one, one that
/// does not exist, or task from an Ask-only member is refused: invalid_task,
/// nothing written.
#[tokio::test]
async fn a_lead_binds_a_section_to_a_task_of_its_project_that_is_not_archived() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, _) = task_in(&ws, &project, "Design the page");
    let (archived, _) = task_in(&ws, &project, "Old work");
    task_set(&ws, &archived, json!({"archived":true}));
    let other = ws.store.create_project("Elsewhere", Default::default()).unwrap().id;
    let (foreign, _) = task_in(&ws, &other, "Theirs");

    for (reference, why) in [(foreign.as_str(), "not a task of this Project"), (archived.as_str(), "is archived"), ("T-999", "No task is T-999")] {
        let refused = reject(&ws, "a", input("bad", 0, vec![bound("page", "status", reference)])).await;
        assert_eq!((codes(&refused), refused["problems"][0]["path"].clone()), (vec!["invalid_task".to_owned()], json!("changes[0].task")));
        assert!(refused["problems"][0]["reason"].as_str().unwrap().contains(why), "{refused}");
    }
    let mut ask = put("question", "ask");
    ask["task"] = json!(task);
    let refused = reject(&ws, "b", input("b1", 0, vec![ask])).await;
    assert_eq!(codes(&refused), ["invalid_task"], "an Ask-only member binds nothing");
    assert_eq!(version(&ws, &project), 0, "nothing was written");

    let answer = accept(&ws, "a", input("a1", 0, vec![bound("page", "status", &task)])).await;
    assert_eq!(answer["sections"][0]["task"], json!(task), "the answer says which task");
    let read = brief(&ws, "a");
    assert_eq!(card(&read, "page")["task"]["id"], json!(task));
    assert_eq!(card(&read, "page")["task"]["status"], "doing");
    // A put without task keeps it, and every version has it.
    let answer = accept(&ws, "a", input("a2", 1, vec![put("page", "status")])).await;
    assert!(answer["sections"][0].get("task").is_none(), "a change without task says nothing of it");
    assert_eq!(card(&brief(&ws, "a"), "page")["task"]["id"], json!(task));
    // An edit of the binding alone: null unbinds, and the section is no card.
    accept(&ws, "a", input("a3", 2, vec![json!({"op":"edit","key":"page","task":null})])).await;
    assert!(section(&brief(&ws, "a"), "page").get("card").is_none());
    accept(&ws, "a", input("a4", 3, vec![json!({"op":"edit","key":"page","task":task})])).await;
    assert_eq!(card(&brief(&ws, "a"), "page")["task"]["id"], json!(task));
    assert_eq!(sections::live_key(&ws.store.db.read().unwrap(), &project, "page").unwrap().unwrap().version, 4);
    let refused = reject(&ws, "a", input("a5", 4, vec![json!({"op":"edit","key":"page","task":5})])).await;
    assert_eq!(codes(&refused), ["invalid_task"]);
}

/// Who answers for a card, read each time: the task's newest executor not
/// yet released, else its assignee, else nobody.
#[tokio::test]
async fn the_responsible_agent_is_the_newest_executor_not_released_else_the_assignee_else_none() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Design the page");
    accept(&ws, "a", input("a1", 0, vec![bound("page", "status", &task)])).await;
    assert_eq!(card(&brief(&ws, "a"), "page")["responsible"], Value::Null, "no executor, no assignee");

    task_set(&ws, &task, json!({"assigneeAgentId":"a"}));
    assert_eq!(card(&brief(&ws, "a"), "page")["responsible"], json!({"agentId":"a","name":"Agent a","kind":"lead","state":"working"}));

    role(&ws.store, "b", &internal, "agent:a", "d1", "running", None);
    let responsible = card(&brief(&ws, "a"), "page")["responsible"].clone();
    assert_eq!((responsible["agentId"].clone(), responsible["kind"].clone(), responsible["state"].clone()),
        (json!("b"), json!("executor"), json!("running")), "the executor before the assignee");
    role(&ws.store, "c", &internal, "agent:a", "d2", "running", None);
    assert_eq!(card(&brief(&ws, "a"), "page")["responsible"]["agentId"], "c", "the newest executor");
    // Home shows the same card.
    let panel = panel(&ws);
    let shown = panel["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == "page").unwrap();
    assert_eq!(shown["card"]["responsible"]["agentId"], "c");
    ws.store.db.write().unwrap().execute("UPDATE agent_roles SET archived_at='2026-11-13T00:00:00Z' WHERE agent_id='c'", []).unwrap();
    assert_eq!(card(&brief(&ws, "a"), "page")["responsible"]["agentId"], "b", "a released executor no longer answers for it");
}

/// The card's responsible executor writes report and status sub-topics under
/// its card's topic, its own and shown with the card. Under another topic,
/// or once it is no longer the task's current executor, it is refused with
/// not_card_responsible; a top-level report stays ask_only; released, it can
/// write nothing.
#[tokio::test]
async fn only_the_cards_current_executor_writes_sub_topics_under_its_card() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Design the page");
    let (other, _) = task_in(&ws, &project, "Other work");
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound("page", "status", &task), bound("misc", "status", &other), put("free", "status")])).await;

    accept(&ws, "c", input("c1", 1, vec![put("page/result", "report")])).await;
    accept(&ws, "c", input("c2", 2, vec![json!({"op":"edit","key":"page/result","elements":{"note":{"type":"Markdown","props":{"text":"Edited."}}}})])).await;
    let row = sections::live_key(&ws.store.db.read().unwrap(), &project, "page/result").unwrap().unwrap();
    assert_eq!((row.owner_id.as_str(), row.version), ("c", 2), "its own section");
    let panel = panel(&ws);
    assert!(keys(&panel, "sections").contains(&"page/result".to_owned()), "shown with its card");
    assert!(!keys(&panel, "teamSections").contains(&"page/result".to_owned()));
    assert_eq!(card(&brief(&ws, "a"), "page/result")["task"]["id"], json!(task), "a sub-topic is its topic's task's");

    for (key, code) in [("misc/result", "not_card_responsible"), ("free/result", "not_card_responsible"), ("result", "ask_only")] {
        let refused = reject(&ws, "c", input("c3", 3, vec![put(key, "status")])).await;
        assert_eq!(codes(&refused), [code], "{key}: {refused}");
    }
    // A gate or own ask is no card a sub-topic may be written under.
    accept(&ws, "c", input("c4", 3, vec![put("mine", "ask")])).await;
    assert_eq!(codes(&reject(&ws, "c", input("c5", 4, vec![put("mine/result", "report")])).await), ["not_card_responsible"]);

    // A newer executor of the task answers for the card now.
    role(&ws.store, "b", &internal, "agent:a", "d2", "running", None);
    assert_eq!(codes(&reject(&ws, "c", input("c6", 4, vec![put("page/more", "report")])).await), ["not_card_responsible"]);
    accept(&ws, "b", input("b1", 4, vec![put("page/more", "report")])).await;
    // Released (its role archived), it is refused too.
    ws.store.db.write().unwrap().execute("UPDATE agent_roles SET archived_at='2026-11-13T00:00:00Z' WHERE agent_id='b'", []).unwrap();
    assert_eq!(codes(&reject(&ws, "b", input("b2", 5, vec![put("page/more", "status")])).await), ["not_card_responsible"]);
    // And closed by its release, it can't write at all.
    ws.store.db.write().unwrap().execute("UPDATE agent_roles SET archived_at=NULL WHERE agent_id='b'", []).unwrap();
    ws.release_executor(Some("a"), "b").await.unwrap();
    assert!(call(&ws, "b", input("b3", 5, vec![put("page/more", "status")])).await.is_err(), "a released executor is closed");
}

/// The exception lets a card's executor write its own sub-topics, never
/// change a lead's: the lead's page/lead-note under the same card is
/// refused to its put, edit and patch alike with not_owner, its owner and
/// version as they were, while the executor still writes a sub-topic of
/// its own beside it.
#[tokio::test]
async fn a_cards_executor_never_changes_a_leads_sub_topic_under_its_card() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Design the page");
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound("page", "status", &task), put("page/lead-note", "status")])).await;
    let note = || sections::live_key(&ws.store.db.read().unwrap(), &project, "page/lead-note").unwrap().expect("a live section");
    let before = note();
    assert_eq!((before.owner_id.as_str(), before.version, version(&ws, &project)), ("a", 1, 1));

    let text = json!({"type":"Markdown","props":{"text":"Mine now."}});
    let changes = [
        ("c-put", put("page/lead-note", "status")),
        ("c-edit", json!({"op":"edit","key":"page/lead-note","elements":{"note":text}})),
        ("c-patch", json!({"op":"patch","key":"page/lead-note","patch":[{"op":"replace","path":"/elements/note/props/text","value":"Mine now."}]})),
    ];
    for (request, change) in changes {
        let refused = reject(&ws, "c", input(request, 1, vec![change])).await;
        assert_eq!((codes(&refused), refused["problems"][0]["path"].clone()), (vec!["not_owner".to_owned()], json!("changes[0].key")), "{request}: {refused}");
        let after = note();
        assert_eq!((after.owner_id.as_str(), after.version, after.seq, version(&ws, &project)), ("a", 1, before.seq, 1), "{request} changed nothing");
    }
    // It is refused as the owner rule refuses anyone, not as an Ask-only member.
    accept(&ws, "c", input("c-own", 1, vec![put("page/result", "report")])).await;
    assert_eq!(note().owner_id, "a");
}

/// When its task is done, a card and the sub-topics under it leave the live
/// Brief as archived: a status, and a report read in its current version.
/// A report the user has not read stays until they open it; an unresolved
/// ask until its owner resolves it. Implicit bindings and other cards stay.
#[tokio::test]
async fn a_done_task_archives_what_was_read_and_keeps_an_unread_report_until_it_is_opened() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Design the page");
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound("page", "report", &task), put("page/unread", "report"), put("page/ask", "ask"), put("other", "status")])).await;
    accept(&ws, "c", input("c1", 1, vec![put("page/result", "status"), put("gate", "ask")])).await;
    open(&ws, &project, "page");

    let done = task_set(&ws, &task, json!({"status":"done"}));
    assert_eq!(done["task"]["status"], "done");
    assert_eq!(row(&ws, &project, "page"), (false, Some("archived".into())), "a report read in its current version");
    assert_eq!(row(&ws, &project, "page/result"), (false, Some("archived".into())), "a status");
    assert_eq!(row(&ws, &project, "page/unread"), (true, None), "a report not read yet stays");
    assert_eq!(row(&ws, &project, "page/ask"), (true, None), "an unresolved ask stays");
    assert_eq!((row(&ws, &project, "other"), row(&ws, &project, "gate")), ((true, None), (true, None)), "other cards and implicit bindings stay");
    assert_eq!(version(&ws, &project), 2, "the Brief's version, as with a Seen mark");
    let history = panel(&ws)["brief"]["history"].clone();
    let archived = history.as_array().unwrap().iter().find(|s| s["key"] == "page").unwrap();
    assert_eq!((archived["historyReason"].clone(), archived["card"]["task"]["status"].clone()), (json!("archived"), json!("done")));
    // Its owner is told why it left.
    let refused = reject(&ws, "a", input("a2", 2, vec![json!({"op":"edit","key":"page","elements":{"note":{"type":"Markdown","props":{"text":"x"}}}})])).await;
    assert!(refused["problems"][0]["reason"].as_str().unwrap().contains("ended"), "{refused}");

    // Opened now, the unread report goes too.
    let opened = open(&ws, &project, "page/unread");
    assert_eq!((opened["recorded"].clone(), opened["archived"].clone()), (json!(true), json!(true)));
    assert_eq!(row(&ws, &project, "page/unread"), (false, Some("archived".into())));

    // Reopened, the task gets none of its cards back; done again, nothing more leaves.
    task_set(&ws, &task, json!({"status":"doing"}));
    task_set(&ws, &task, json!({"status":"cancelled"}));
    assert_eq!(row(&ws, &project, "page/ask"), (true, None));
}

#[tokio::test]
async fn an_archived_or_cancelled_task_archives_its_card_too() {
    let (_dir, ws, project) = lab();
    let (first, _) = task_in(&ws, &project, "First");
    let (second, _) = task_in(&ws, &project, "Second");
    accept(&ws, "a", input("a1", 0, vec![bound("one", "status", &first), bound("two", "status", &second)])).await;
    task_set(&ws, &first, json!({"archived":true}));
    task_set(&ws, &second, json!({"status":"cancelled"}));
    assert_eq!((row(&ws, &project, "one"), row(&ws, &project, "two")), ((false, Some("archived".into())), (false, Some("archived".into()))));
}

/// A new dispatch of the same task (a design, then its build): the task goes
/// on, so its card stays, its new executor answers for it, and the old
/// executor's sub-topics are its dispatcher's, still on the card.
#[tokio::test]
async fn a_new_executor_of_the_same_task_keeps_the_card_and_answers_for_it() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Design the page");
    role(&ws.store, "b", &internal, "agent:a", "d1", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound("page", "status", &task)])).await;
    accept(&ws, "b", input("b1", 1, vec![put("page/design", "report")])).await;
    role(&ws.store, "c", &internal, "agent:a", "d2", "running", None);
    ws.release_executor(Some("a"), "b").await.unwrap();

    assert_eq!(row(&ws, &project, "page"), (true, None), "the card stays");
    let design = sections::live_key(&ws.store.db.read().unwrap(), &project, "page/design").unwrap().expect("still on the card");
    assert_eq!(design.owner_id, "a", "the old executor's sub-topic is its dispatcher's");
    let read = brief(&ws, "a");
    assert_eq!((card(&read, "page")["responsible"]["agentId"].clone(), card(&read, "page/design")["responsible"]["agentId"].clone()),
        (json!("c"), json!("c")));
    assert!(keys(&panel(&ws), "sections").contains(&"page/design".to_owned()));
}

/// A reply begun for a card's executor that has since been released goes to
/// whoever answers for the card now, told it is the card's responsible
/// Agent; an ask's reply still goes to its owner, who resolves it.
#[tokio::test]
async fn a_reply_to_a_released_executors_card_goes_to_its_responsible_agent() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Design the page");
    role(&ws.store, "b", &internal, "agent:a", "d1", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound("page", "status", &task)])).await;
    accept(&ws, "b", input("b1", 1, vec![put("question", "ask")])).await;
    role(&ws.store, "c", &internal, "agent:a", "d2", "running", None);
    ws.release_executor(Some("a"), "b").await.unwrap();

    let workspace = ws.store.workspace_id().unwrap();
    let reply = |key: &str, id: &str, card: Option<(i64, &str)>, ask: Option<i64>| home::ReplyInput {
        key: Some(key.into()), agent_id: "b".into(), text: if ask.is_some() { String::new() } else { "Looks right.".into() },
        client_message_id: id.into(), choice: ask.map(|_| "left".into()), version: card.map(|(v, _)| v),
        title: card.map(|(_, t)| t.to_owned()), ask_version: ask, workspace_id: ask.map(|_| workspace.clone()), form: None, images: vec![] };
    home::reply(&ws, project.clone(), reply("page", "r1", Some((1, "About page")), None)).await.unwrap();
    let sent = ws.store.receipt("c", "r1").unwrap().expect("the card's responsible Agent has it");
    assert!(sent.input.text.contains(&format!("\nThis card is bound to task {task}; you are its responsible Agent.\n\nLooks right.")), "{}", sent.input.text);
    assert!(ws.store.receipt("a", "r1").unwrap().is_none() && ws.store.receipt("b", "r1").unwrap().is_none());
    // Sent again, the same reply is found whatever its line said.
    home::reply(&ws, project.clone(), reply("page", "r1", Some((1, "About page")), None)).await.unwrap();

    let shown = sections::live_key(&ws.store.db.read().unwrap(), &project, "question").unwrap().unwrap().version;
    home::reply(&ws, project.clone(), reply("question", "r2", None, Some(shown))).await.unwrap();
    assert!(ws.store.receipt("a", "r2").unwrap().is_some(), "the ask's owner, its executor's dispatcher, resolves it");
    assert!(ws.store.receipt("c", "r2").unwrap().is_none());
}

#[test]
fn a_card_reply_is_the_same_reply_with_or_without_its_bound_line() {
    let plain = home::compose_card("w", "Code", "p", "page", 3, "Page", "Looks right.");
    let line = home::compose_bound_card("w", "Code", "p", "page", 3, "Page", Some("YN-90"), "Looks right.");
    assert_eq!(plain, "Reply from the user on Home, to version 3 of the Project Brief section `page` (\"Page\") of Code (Workspace w, Project p):\n\nLooks right.");
    assert_eq!(line, "Reply from the user on Home, to version 3 of the Project Brief section `page` (\"Page\") of Code (Workspace w, Project p):\nThis card is bound to task YN-90; you are its responsible Agent.\n\nLooks right.");
    let head = home::card_head("w", "Code", "p", "page", 3, "Page");
    for sent in [&plain, &line] {
        assert!(home::same_card_reply(sent, &head, " Looks right. \n"));
    }
    assert!(!home::same_card_reply(&plain, &head, "Something else."));
    assert!(!home::same_card_reply(&line.replace("YN-90", "YN-90\nExtra"), &head, "Looks right."));
    assert!(!home::same_card_reply(&home::compose_card("w", "Code", "p", "page", 4, "Page", "Looks right."), &head, "Looks right."));
}

/// A section written before S2a, or without task (neither a sub-topic of a
/// card, nor an executor's, nor a gate): its row gains a NULL task_id once,
/// however often the migration runs, and brief_get and Home show it exactly
/// as before, with no card.
#[tokio::test]
async fn a_section_without_a_task_reads_as_before_and_the_migration_runs_again_unchanged() {
    let (_dir, ws, _) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report"), put("plan/notes", "status"), put("decide", "ask")])).await;
    let read = || {
        let brief = brief(&ws, "a");
        let shown = panel(&ws)["brief"]["sections"].clone();
        (brief["sections"].clone(), shown)
    };
    let before = read();
    // An older database: the column did not exist yet.
    {
        let db = ws.store.db.write().unwrap();
        db.execute_batch("DROP INDEX project_brief_sections_task; ALTER TABLE project_brief_sections DROP COLUMN task_id;").unwrap();
        migrate(&db).unwrap();
        migrate(&db).unwrap();
        let columns: i64 = db.query_row("SELECT COUNT(*) FROM pragma_table_info('project_brief_sections') WHERE name='task_id'", [], |r| r.get(0)).unwrap();
        let bound: i64 = db.query_row("SELECT COUNT(*) FROM project_brief_sections WHERE task_id IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!((columns, bound), (1, 0));
    }
    let after = read();
    assert_eq!(after, before, "the same JSON");
    for section in after.0.as_array().unwrap().iter().chain(after.1.as_array().unwrap()) {
        let mut fields: Vec<&str> = section.as_object().unwrap().keys().map(String::as_str).collect();
        fields.sort();
        assert!(!fields.contains(&"card"), "{fields:?}");
        let known = ["ask", "attachments", "body", "history", "id", "key", "kind", "opened", "owner", "refs", "seen", "status", "title", "updatedAt", "updatedTurnId", "version"];
        assert!(fields.iter().all(|field| known.contains(field)), "{fields:?}");
    }
}

/// The exception lets a card's executor write where it otherwise could not,
/// never more than anyone may: a topic still has at most MAX_SUBTOPICS
/// sub-topics, and the generated validator checks its sections as any
/// other's, a body over its limit refused.
#[tokio::test]
async fn a_cards_executor_writes_within_the_limits_every_section_has() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Design the page");
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound("page", "status", &task), put("page/one", "report"), put("page/two", "report"), put("page/three", "report")])).await;
    accept(&ws, "c", input("c1", 1, vec![put("page/four", "report")])).await;
    let full = reject(&ws, "c", input("c2", 2, vec![put("page/five", "report")])).await;
    assert_eq!(codes(&full), ["topic_limit"], "{full}");
    assert!(full["problems"][0]["reason"].as_str().unwrap().contains(&format!("{MAX_SUBTOPICS} sub-topics")));

    let checker = Checker::Node(Arc::new(crate::results::Validator::from_env()));
    let mut large = put("page/four", "report");
    large["body"] = body(&"x".repeat(65_000));
    let refused = update::update(&ws, &checker, "c", input("c3", 2, vec![large])).await.unwrap().unwrap_err();
    assert!(codes(&refused).iter().any(|code| code == "too_large" || code == "too_long"), "{refused}");
    // The same validator takes its ordinary section.
    let answer = update::update(&ws, &checker, "c", input("c4", 2, vec![put("page/four", "status")])).await.unwrap();
    assert!(answer.is_ok(), "{answer:?}");
}

/// Released, a card's executor writes nothing more, and what it wrote under
/// its card stays there: its dispatcher's once handed over, or still its own
/// when the user dispatched it, shown with the card either way.
#[tokio::test]
async fn a_released_executors_sub_topics_stay_on_its_card() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (first, internal) = task_in(&ws, &project, "Design the page");
    let (second, other) = task_in(&ws, &project, "Build the page");
    role(&ws.store, "b", &internal, "agent:a", "d1", "running", None);
    role(&ws.store, "c", &other, "user", "d2", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound("design", "status", &first), bound("build", "status", &second)])).await;
    accept(&ws, "b", input("b1", 1, vec![put("design/result", "report")])).await;
    accept(&ws, "c", input("c1", 2, vec![put("build/result", "report")])).await;
    ws.release_executor(Some("a"), "b").await.unwrap();
    ws.release_executor(None, "c").await.unwrap();

    let owner = |key: &str| sections::live_key(&ws.store.db.read().unwrap(), &project, key).unwrap().map(|row| row.owner_id);
    assert_eq!(owner("design/result").as_deref(), Some("a"), "handed to the Agent that dispatched it");
    assert_eq!(owner("build/result").as_deref(), Some("c"), "a user's executor keeps it");
    let shown = keys(&panel(&ws), "sections");
    assert!(shown.contains(&"design/result".to_owned()) && shown.contains(&"build/result".to_owned()), "{shown:?}");
    let now = version(&ws, &project);
    for (executor, key) in [("b", "design/result"), ("c", "build/result")] {
        let mut change = put(key, "report");
        change["title"] = json!("Again");
        assert!(call(&ws, executor, input("again", now, vec![change])).await.is_err(), "{executor} is released");
    }
    assert_eq!((owner("design/result").as_deref(), owner("build/result").as_deref()), (Some("a"), Some("c")));
}

/// YN-136: a task's card does not count toward the Brief's 12 topics. With
/// 12 topics not bound to a task, a lead still puts a card and its executor
/// a sub-topic under it, while a 13th topic not bound to a task (or a
/// sub-topic that would start one) is refused with topic_limit.
#[tokio::test]
async fn a_tasks_card_does_not_count_toward_the_topic_limit() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Design the page");
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    let topics: Vec<Value> = (0..MAX_TOPICS).map(|n| put(&format!("t{n}"), "status")).collect();
    accept(&ws, "a", input("a1", 0, topics)).await;

    accept(&ws, "a", input("a2", 1, vec![bound("yn-1", "status", &task)])).await;
    assert_eq!(card(&brief(&ws, "a"), "yn-1")["task"]["id"], json!(task));
    for (request, key) in [("a3", "t12"), ("a4", "t12/part")] {
        let refused = reject(&ws, "a", input(request, 2, vec![put(key, "status")])).await;
        assert_eq!((codes(&refused), refused["problems"][0]["path"].clone()), (vec!["topic_limit".to_owned()], json!("changes[0].key")), "{key}");
        assert!(refused["problems"][0]["reason"].as_str().unwrap().starts_with("12 of the Brief's 12 topics already count"), "{refused}");
    }
    accept(&ws, "c", input("c1", 2, vec![put("yn-1/result", "report")])).await;
    // A put of the card without task keeps it bound, so it adds no topic.
    accept(&ws, "a", input("a5", 3, vec![put("yn-1", "status")])).await;
    assert_eq!(card(&brief(&ws, "a"), "yn-1")["task"]["id"], json!(task));
}

/// Unbinding a card makes its topic count again: at the limit it is refused
/// with topic_limit and the section stays its task's card; once a topic not
/// bound to a task is removed, the same unbinding is accepted.
#[tokio::test]
async fn unbinding_a_card_at_the_limit_is_refused() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, _) = task_in(&ws, &project, "Design the page");
    let mut changes: Vec<Value> = (0..MAX_TOPICS).map(|n| put(&format!("t{n}"), "status")).collect();
    changes.push(bound("yn-1", "status", &task));
    accept(&ws, "a", input("a1", 0, changes)).await;

    let unbind = json!({"op":"edit","key":"yn-1","task":null});
    let mut put_unbound = put("yn-1", "status");
    put_unbound["task"] = Value::Null;
    for (request, change) in [("a2", unbind.clone()), ("a3", put_unbound)] {
        let refused = reject(&ws, "a", input(request, 1, vec![change])).await;
        assert_eq!((codes(&refused), refused["problems"][0]["path"].clone()), (vec!["topic_limit".to_owned()], json!("changes[0].task")), "{request}");
        assert!(refused["problems"][0]["reason"].as_str().unwrap().contains("Unbinding yn-1"), "{refused}");
        assert_eq!(card(&brief(&ws, "a"), "yn-1")["task"]["id"], json!(task), "{request}: still the task's card");
    }
    assert_eq!(version(&ws, &project), 1, "nothing was written");

    accept(&ws, "a", input("a4", 1, vec![op("remove", "t0"), unbind])).await;
    assert!(section(&brief(&ws, "a"), "yn-1").get("card").is_none(), "unbound");
}

/// Only one card per open task is left out of the count (review of #962):
/// a second topic bound to the same task, or a topic bound to a task that
/// has already ended (which never archives it), counts like any other and
/// is refused at the limit. A card whose task ends while it stays live (a
/// report not read yet) counts again: the Brief stands above the limit,
/// takes no new topic until enough leave, and still takes every change that
/// adds none.
#[tokio::test]
async fn only_one_card_per_open_task_is_left_out_of_the_topic_count() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, _) = task_in(&ws, &project, "Design the page");
    let (ended, _) = task_in(&ws, &project, "Old work");
    task_set(&ws, &ended, json!({"status":"done"}));
    let mut changes: Vec<Value> = (0..MAX_TOPICS).map(|n| put(&format!("t{n}"), "status")).collect();
    changes.push(bound("yn-1", "report", &task));
    accept(&ws, "a", input("a1", 0, changes)).await;
    for (request, key, reference) in [("a2", "yn-1-again", task.as_str()), ("a3", "old", ended.as_str())] {
        let refused = reject(&ws, "a", input(request, 1, vec![bound(key, "status", reference)])).await;
        assert_eq!((codes(&refused), refused["problems"][0]["path"].clone()), (vec!["topic_limit".to_owned()], json!("changes[0].key")), "{key}: {refused}");
    }
    // Rebinding the card to the ended task makes it count too.
    let rebind = json!({"op":"edit","key":"yn-1","task":ended});
    assert_eq!(codes(&reject(&ws, "a", input("a4", 1, vec![rebind])).await), ["topic_limit"]);

    task_set(&ws, &task, json!({"status":"done"}));
    assert_eq!(row(&ws, &project, "yn-1"), (true, None), "a report not read yet stays live after its task ends");
    assert_eq!(codes(&reject(&ws, "a", input("a5", 1, vec![put("t12", "status")])).await), ["topic_limit"], "13 count now");
    accept(&ws, "a", input("a6", 1, vec![put("t0", "status")])).await;
    assert_eq!(codes(&reject(&ws, "a", input("a7", 2, vec![op("remove", "t1"), put("t12", "status")])).await), ["topic_limit"]);
    accept(&ws, "a", input("a8", 2, vec![op("remove", "t1"), op("remove", "t2"), put("t12", "status")])).await;
}
