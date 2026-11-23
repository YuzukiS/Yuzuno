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
/// Brief as archived: a status, a report read in its current version and,
/// since YN-195, one the user has not read yet too, no longer counted as
/// new. An unresolved ask stays until its owner resolves it. Implicit
/// bindings and other cards stay.
#[tokio::test]
async fn a_done_task_archives_its_cards_and_a_report_not_read_yet_too() {
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
    assert_eq!(row(&ws, &project, "page/unread"), (false, Some("archived".into())), "a report not read yet goes too");
    assert_eq!(row(&ws, &project, "page/ask"), (true, None), "an unresolved ask stays");
    assert_eq!((row(&ws, &project, "other"), row(&ws, &project, "gate")), ((true, None), (true, None)), "other cards and implicit bindings stay");
    assert_eq!(version(&ws, &project), 2, "the Brief's version, as with a Seen mark");
    assert_eq!(panel(&ws)["unseen"], 3, "new: the ask under the card, the other card and the gate, not the unread report");
    let history = panel(&ws)["brief"]["history"].clone();
    let archived = history.as_array().unwrap().iter().find(|s| s["key"] == "page").unwrap();
    assert_eq!((archived["historyReason"].clone(), archived["card"]["task"]["status"].clone()), (json!("archived"), json!("done")));
    super::history_index_tests::check(&ws.store);
    // Its owner is told why it left.
    let refused = reject(&ws, "a", input("a2", 2, vec![json!({"op":"edit","key":"page","elements":{"note":{"type":"Markdown","props":{"text":"x"}}}})])).await;
    assert!(refused["problems"][0]["reason"].as_str().unwrap().contains("ended"), "{refused}");

    // A report bound to the task after it ended stays live, as one an older Core kept live unread, and leaves once opened.
    accept(&ws, "a", input("a3", 2, vec![bound("late", "report", &task)])).await;
    assert_eq!(row(&ws, &project, "late"), (true, None));
    let opened = open(&ws, &project, "late");
    assert_eq!((opened["recorded"].clone(), opened["archived"].clone()), (json!(true), json!(true)));
    assert_eq!(row(&ws, &project, "late"), (false, Some("archived".into())));

    // Reopened, the task gets none of its cards back; done again, nothing more leaves.
    task_set(&ws, &task, json!({"status":"doing"}));
    task_set(&ws, &task, json!({"status":"cancelled"}));
    assert_eq!(row(&ws, &project, "page/ask"), (true, None));
}

/// YN-195: a lead the user no longer lists leaves its reports and statuses
/// there to history as lead-left, and reads why; its Asks stay, and another
/// lead's sections are untouched. One that moves to another Project leaves
/// them live for a lead to claim, as before.
#[tokio::test]
async fn a_lead_that_stops_leading_leaves_its_reports_and_statuses_to_history() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a", "b"]);
    accept(&ws, "a", input("a1", 0, vec![put("audit", "report"), put("state", "status"), put("pick", "ask")])).await;
    accept(&ws, "b", input("b1", 1, vec![put("plan", "report")])).await;
    set_leads(&ws, &project, &["b"]);
    for key in ["audit", "state"] {
        assert_eq!(row(&ws, &project, key), (false, Some("lead-left".into())), "{key}");
    }
    assert_eq!((row(&ws, &project, "pick"), row(&ws, &project, "plan")), ((true, None), (true, None)));
    assert_eq!(version(&ws, &project), 2, "the Brief's version, as with a card archived with its task");
    let history = keys(&panel(&ws), "history");
    assert!(history.contains(&"audit".to_owned()) && history.contains(&"state".to_owned()), "{history:?}");
    let left = brief(&ws, "a")["you"]["recentlyLeft"].clone();
    assert!(left.as_array().unwrap().iter().any(|entry| entry["key"] == "audit" && entry["reason"] == "lead-left"), "{left}");
    // A lead that moves to another Project leaves them live, to be claimed.
    let other = ws.store.create_project("Elsewhere", std::collections::BTreeMap::new()).unwrap().id;
    ws.store.set_agent_project("b", Some(&other)).unwrap();
    assert_eq!(row(&ws, &project, "plan"), (true, None));
}

/// Review c6e802f3: a lead left out keeps the card of a task still open, and
/// what that task's executor wrote under it; both leave with the task. An
/// unresolved Ask under the card stays through both, until it is resolved.
/// Its other reports still go to history as lead-left.
#[tokio::test]
async fn a_lead_left_out_keeps_the_card_of_an_open_task_until_the_task_ends() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a", "b"]);
    let (task, internal) = task_in(&ws, &project, "Design the page");
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound("page", "status", &task), put("page/notes", "report"), put("page/pick", "ask"), put("audit", "report")])).await;
    accept(&ws, "c", input("c1", 1, vec![put("page/result", "report")])).await;
    set_leads(&ws, &project, &["b"]);
    assert_eq!(row(&ws, &project, "audit"), (false, Some("lead-left".into())), "a report bound to no task");
    for key in ["page", "page/notes", "page/pick", "page/result"] {
        assert_eq!(row(&ws, &project, key), (true, None), "{key}: the open task's card stays");
    }
    // The executor still writes under the card: its topic is live and bound.
    accept(&ws, "c", input("c2", 2, vec![put("page/result", "report")])).await;
    task_set(&ws, &task, json!({"status":"done"}));
    for key in ["page", "page/notes", "page/result"] {
        assert_eq!(row(&ws, &project, key), (false, Some("archived".into())), "{key}: leaves with its task");
    }
    assert_eq!(row(&ws, &project, "page/pick"), (true, None), "an unresolved ask stays until it is resolved");
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
        title: card.map(|(_, t)| t.to_owned()), ask_version: ask, workspace_id: ask.map(|_| workspace.clone()), form: None, images: vec![], files: vec![], intent: Default::default(), note: None };
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
        let known = ["ask", "attachments", "author", "body", "history", "id", "key", "kind", "opened", "owner", "refs", "seen", "status", "title", "updatedAt", "updatedTurnId", "version"];
        assert!(fields.iter().all(|field| known.contains(field)), "{fields:?}");
    }
}

/// YN-195 (review ede2b8f1): an edit that only binds or unbinds a status
/// section writes no content, so its facts keep their asOf, stale or not.
#[tokio::test]
async fn binding_a_status_to_a_task_keeps_its_as_of() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, _) = task_in(&ws, &project, "Design the page");
    let mut old = put("page", "status");
    old["status"] = json!({"asOf":"2026-01-01T00:00:00Z","validFor":60});
    accept(&ws, "a", input("a1", 0, vec![old])).await;
    accept(&ws, "a", input("a2", 1, vec![json!({"op":"edit","key":"page","task":task})])).await;
    let read = brief(&ws, "a");
    assert_eq!(card(&read, "page")["task"]["id"], json!(task));
    assert_eq!(section(&read, "page")["status"], json!({"asOf":"2026-01-01T00:00:00Z","validFor":60,"stale":true}));
    accept(&ws, "a", input("a3", 2, vec![json!({"op":"edit","key":"page","task":null})])).await;
    assert_eq!(section(&brief(&ws, "a"), "page")["status"]["asOf"], "2026-01-01T00:00:00Z");
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
    assert!(full["problems"][0]["reason"].as_str().unwrap().contains(&format!("{MAX_SUBTOPICS} report or status sub-topics")));

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
/// is refused at the limit. A card whose task ends while it stays live (an
/// unresolved Ask; a report leaves with its task since YN-195) counts again: the Brief stands above the limit,
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
    changes.push(bound("yn-1", "ask", &task));
    accept(&ws, "a", input("a1", 0, changes)).await;
    for (request, key, reference) in [("a2", "yn-1-again", task.as_str()), ("a3", "old", ended.as_str())] {
        let refused = reject(&ws, "a", input(request, 1, vec![bound(key, "status", reference)])).await;
        assert_eq!((codes(&refused), refused["problems"][0]["path"].clone()), (vec!["topic_limit".to_owned()], json!("changes[0].key")), "{key}: {refused}");
    }
    // Rebinding the card to the ended task makes it count too.
    let rebind = json!({"op":"edit","key":"yn-1","task":ended});
    assert_eq!(codes(&reject(&ws, "a", input("a4", 1, vec![rebind])).await), ["topic_limit"]);

    task_set(&ws, &task, json!({"status":"done"}));
    assert_eq!(row(&ws, &project, "yn-1"), (true, None), "an unresolved ask stays live after its task ends");
    assert_eq!(codes(&reject(&ws, "a", input("a5", 1, vec![put("t12", "status")])).await), ["topic_limit"], "13 count now");
    accept(&ws, "a", input("a6", 1, vec![put("t0", "status")])).await;
    assert_eq!(codes(&reject(&ws, "a", input("a7", 2, vec![op("remove", "t1"), put("t12", "status")])).await), ["topic_limit"]);
    accept(&ws, "a", input("a8", 2, vec![op("remove", "t1"), op("remove", "t2"), put("t12", "status")])).await;
}

/// The live row under `key`: its owner, author and version.
fn written(ws: &Workspace, project: &str, key: &str) -> (String, String, String, i64) {
    let row = sections::live_key(&ws.store.db.read().unwrap(), project, key).unwrap().expect("a live section");
    (row.owner_id, row.owner_name, row.author_id, row.version)
}

fn edit_note(key: &str, text: &str) -> Value {
    json!({"op":"edit","key":key,"elements":{"note":{"type":"Markdown","props":{"text":text}}}})
}

/// YN-212 C1: a task's card is written by its Project's leads, not only by
/// the lead that put it. Another lead puts, edits and patches it while its
/// owner still leads, without a claim; the owner and the binding stay, and
/// each version names its author. Removing it stays its owner's, and so do
/// binding it to another task or unbinding it, and its refresh, which runs as
/// its owner (PR 1086 R1). A lead's section bound to no task stays its owner's.
#[tokio::test]
async fn another_lead_writes_an_open_tasks_card_while_its_owner_still_leads() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a", "b"]);
    let (task, _) = task_in(&ws, &project, "Sign the release");
    let (other, _) = task_in(&ws, &project, "Other work");
    let key = task.to_lowercase();
    accept(&ws, "a", input("a1", 0, vec![bound(&key, "status", &task), put("plan", "status")])).await;
    assert_eq!(written(&ws, &project, &key), ("a".into(), "Agent a".into(), "a".into(), 1));

    accept(&ws, "b", input("b1", 1, vec![put(&key, "status")])).await;
    assert_eq!(written(&ws, &project, &key), ("a".into(), "Agent a".into(), "b".into(), 2), "the owner stays; b wrote it");
    accept(&ws, "b", input("b2", 2, vec![edit_note(&key, "Signing: 3 of 5.")])).await;
    accept(&ws, "b", input("b3", 3, vec![json!({"op":"patch","key":key,"patch":[{"op":"replace","path":"/elements/note/props/text","value":"Signed."}]})])).await;
    let shown = section(&brief(&ws, "a"), &key).clone();
    assert_eq!((shown["owner"]["agentId"].clone(), shown["author"].clone(), shown["card"]["task"]["id"].clone()),
        (json!("a"), json!({"agentId":"b","name":"Agent b"}), json!(task)), "{shown}");
    // At its end the same key becomes the task's report, by another lead too.
    accept(&ws, "b", input("b4", 4, vec![put(&key, "report")])).await;
    assert_eq!(section(&brief(&ws, "a"), &key)["kind"], "report");
    // The owner writes it again: its author again.
    accept(&ws, "a", input("a2", 5, vec![edit_note(&key, "Released.")])).await;
    assert_eq!(written(&ws, &project, &key), ("a".into(), "Agent a".into(), "a".into(), 6));

    for (request, change, code) in [
        ("b-remove", op("remove", &key), "not_owner"),
        ("b-unbind", json!({"op":"edit","key":key,"task":null}), "invalid_task"),
        ("b-rebind", {let mut change = put(&key, "report"); change["task"] = json!(other); change}, "invalid_task"),
        ("b-ask", put(&key, "ask"), "not_owner"),
        ("b-plan", put("plan", "status"), "not_owner"),
        // Its refresh runs as its owner: set, changed or removed by its owner only.
        ("b-refresh", {let mut change = put(&key, "report"); change["refresh"] = json!({"every":"day","instruction":"Sum up the release."}); change},
            "not_owner"),
        ("b-refresh-edit", json!({"op":"edit","key":key,"refresh":{"every":"hours","hours":6}}), "not_owner"),
        ("b-refresh-off", json!({"op":"edit","key":key,"refresh":null}), "not_owner"),
    ] {
        let refused = reject(&ws, "b", input(request, 6, vec![change])).await;
        assert_eq!(codes(&refused), [code], "{request}: {refused}");
    }
    // Naming the task it is bound to changes nothing of the binding.
    let mut same = put(&key, "report");
    same["task"] = json!(task);
    accept(&ws, "b", input("b5", 6, vec![same])).await;
    assert_eq!(written(&ws, &project, &key).0, "a");
}

/// YN-212 C1: the lead that put a card no longer leads (Dev Lead 2 to Dev
/// Lead): the card of its open task stays live (YN-195), Home shows it with
/// the leads' sections though its owner is no lead, and the new lead updates
/// it with no claim.
#[tokio::test]
async fn a_new_lead_updates_the_card_its_old_lead_put_and_home_shows_it() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, _) = task_in(&ws, &project, "Sign the release");
    let key = task.to_lowercase();
    accept(&ws, "a", input("a1", 0, vec![bound(&key, "status", &task)])).await;
    set_leads(&ws, &project, &["b"]);
    accept(&ws, "b", input("b1", 1, vec![edit_note(&key, "Taken over.")])).await;
    assert_eq!(written(&ws, &project, &key), ("a".into(), "Agent a".into(), "b".into(), 2));
    let panel = panel(&ws);
    assert!(keys(&panel, "sections").contains(&key), "{panel}");
    assert!(!keys(&panel, "teamSections").contains(&key));
}

/// YN-212 C1: a task's current executor puts its own task's card at the
/// task's key, bound with task to its task, and keeps writing it; it writes
/// the card a lead put for its task (a front desk's) too, which stays that
/// lead's. It binds nothing else, writes no other task's card, and no other
/// member writes a card it neither leads nor executes. Released, it writes
/// none.
#[tokio::test]
async fn a_tasks_current_executor_writes_its_own_tasks_card_and_no_other() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Build the page");
    let (other, other_internal) = task_in(&ws, &project, "Fix the dock");
    let (key, other_key) = (task.to_lowercase(), other.to_lowercase());
    ws.store.set_agent_project("d", Some(&project)).unwrap();
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    role(&ws.store, "d", &other_internal, "agent:a", "d2", "running", None);

    let answer = accept(&ws, "c", input("c1", 0, vec![bound(&key, "status", &task)])).await;
    assert_eq!(answer["sections"][0]["task"], json!(task));
    assert_eq!(written(&ws, &project, &key), ("c".into(), "Agent c".into(), "c".into(), 1));
    assert_eq!(card(&brief(&ws, "a"), &key)["task"]["id"], json!(task));
    accept(&ws, "c", input("c2", 1, vec![edit_note(&key, "Half done.")])).await;
    accept(&ws, "c", input("c3", 2, vec![bound(&key, "status", &task)])).await;
    // Its sub-topics under its own card, as under a lead's.
    accept(&ws, "c", input("c4", 3, vec![put(&format!("{key}/result"), "report")])).await;
    let panel = panel(&ws);
    assert!(keys(&panel, "sections").contains(&key), "Home shows an executor's card with the leads'");

    // The lead's card of the other task, which d executes.
    accept(&ws, "a", input("a1", 4, vec![bound(&other_key, "status", &other)])).await;
    for (request, change, code) in [
        ("c-elsewhere", bound("page", "status", &task), "invalid_task"),
        ("c-other-task", bound(&other_key, "status", &other), "invalid_task"),
        ("c-other-put", put(&other_key, "status"), "not_card_responsible"),
        ("c-other-edit", edit_note(&other_key, "Mine."), "not_card_responsible"),
        ("c-unbound", put("notes", "status"), "ask_only"),
        ("c-as-ask", put(&key, "ask"), "not_card_responsible"),
    ] {
        let refused = reject(&ws, "c", input(request, 5, vec![change])).await;
        assert_eq!(codes(&refused), [code], "{request}: {refused}");
    }
    // d writes the card a lead put for its task, which stays the lead's.
    accept(&ws, "d", input("d1", 5, vec![edit_note(&other_key, "Fixing.")])).await;
    accept(&ws, "d", input("d2", 6, vec![put(&other_key, "report")])).await;
    assert_eq!(written(&ws, &project, &other_key), ("a".into(), "Agent a".into(), "d".into(), 3));
    assert_eq!(codes(&reject(&ws, "d", input("d3", 7, vec![op("remove", &other_key)])).await), ["ask_only"]);

    // b leads nothing and executes nothing here.
    for (request, change) in [("b-put", put(&key, "status")), ("b-edit", edit_note(&key, "Mine.")), ("b-new", bound("fresh", "status", &task))] {
        let refused = reject(&ws, "b", input(request, 7, vec![change])).await;
        assert!(matches!(codes(&refused)[0].as_str(), "ask_only" | "invalid_task"), "{request}: {refused}");
    }
    // A newer executor of the task answers for it now; the old one is refused.
    role(&ws.store, "b", &internal, "agent:a", "d3", "running", None);
    assert_eq!(codes(&reject(&ws, "c", input("c5", 7, vec![edit_note(&key, "Still me.")])).await), ["not_card_responsible"]);
    accept(&ws, "b", input("b1", 7, vec![edit_note(&key, "Taken over.")])).await;
    assert_eq!(written(&ws, &project, &key), ("c".into(), "Agent c".into(), "b".into(), 4));
}

/// PR 1091 R1: a task given to an Agent here that leads nothing, with no
/// executor (its assignee, as a card route to it leaves it): that Agent
/// puts its task's card at the task's key, a status or a report bound with
/// task, and keeps writing it. Nothing else is its to write for the task:
/// no Ask bound there, no other section a lead bound to the task, no
/// sub-topic under the card, no other task's card. Another member writes
/// none. An executor released from a task, though still its assignee,
/// writes its card no more.
#[tokio::test]
async fn a_tasks_assignee_with_no_executor_writes_only_its_tasks_own_card() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, _) = task_in(&ws, &project, "Write the docs");
    let (other, _) = task_in(&ws, &project, "Fix the dock");
    let (key, other_key) = (task.to_lowercase(), other.to_lowercase());
    task_set(&ws, &task, json!({"assigneeAgentId":"b"}));
    // A lead's other section bound to the task, and the other task's card.
    accept(&ws, "a", input("a1", 0, vec![bound("notes", "status", &task), bound(&other_key, "status", &other)])).await;

    for (request, change, code) in [
        ("b-ask", bound(&key, "ask", &task), "invalid_task"),
        ("b-elsewhere", bound("pages", "status", &task), "invalid_task"),
        ("b-other-task", bound(&other_key, "status", &other), "invalid_task"),
    ] {
        let refused = reject(&ws, "b", input(request, 1, vec![change])).await;
        assert_eq!(codes(&refused), [code], "{request}: {refused}");
    }
    let answer = accept(&ws, "b", input("b1", 1, vec![bound(&key, "status", &task)])).await;
    assert_eq!(answer["sections"][0]["task"], json!(task));
    accept(&ws, "b", input("b2", 2, vec![edit_note(&key, "Half done.")])).await;
    accept(&ws, "b", input("b3", 3, vec![bound(&key, "report", &task)])).await;
    assert_eq!(written(&ws, &project, &key), ("b".into(), "Agent b".into(), "b".into(), 3));
    assert_eq!(card(&brief(&ws, "a"), &key)["responsible"]["agentId"], "b");
    for (request, change) in [
        ("b-notes", edit_note("notes", "Mine.")),
        ("b-notes-put", put("notes", "status")),
        ("b-sub", put(&format!("{key}/result"), "report")),
        ("b-other-edit", edit_note(&other_key, "Mine.")),
    ] {
        let refused = reject(&ws, "b", input(request, 4, vec![change])).await;
        assert_eq!(codes(&refused), ["ask_only"], "{request}: {refused}");
    }
    // c is a member the task is not given to.
    for (request, change, code) in [("c-edit", edit_note(&key, "Mine."), "ask_only"), ("c-put", bound(&key, "status", &task), "invalid_task")] {
        let refused = reject(&ws, "c", input(request, 4, vec![change])).await;
        assert_eq!(codes(&refused), [code], "{request}: {refused}");
    }

    // An executor of the other task, still its assignee once released.
    let internal = crate::collaboration_store::task_key(&ws.store.db.read().unwrap(), &other).unwrap().0;
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    task_set(&ws, &other, json!({"assigneeAgentId":"c"}));
    accept(&ws, "c", input("c1", 4, vec![edit_note(&other_key, "Fixing.")])).await;
    ws.store.db.write().unwrap().execute("UPDATE agent_roles SET archived_at='2026-11-13T00:00:00Z' WHERE agent_id='c'", []).unwrap();
    let refused = reject(&ws, "c", input("c2", 5, vec![edit_note(&other_key, "Still me.")])).await;
    assert_eq!(codes(&refused), ["not_card_responsible"], "{refused}");
}

/// YN-212 C1: two writers of one card read the Brief at the same version;
/// the first write is taken, the second is refused with version_conflict and
/// the card as the first left it, to merge into.
#[tokio::test]
async fn the_later_of_two_writers_of_a_card_gets_a_version_conflict() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Build the page");
    let key = task.to_lowercase();
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound(&key, "status", &task)])).await;
    accept(&ws, "c", input("c1", 1, vec![edit_note(&key, "From the executor.")])).await;
    let refused = reject(&ws, "a", input("a2", 1, vec![edit_note(&key, "From the lead.")])).await;
    assert_eq!(codes(&refused), ["version_conflict"]);
    let latest = &refused["latest"]["sections"][0];
    assert_eq!((latest["key"].clone(), latest["version"].clone(), latest["author"]["agentId"].clone()), (json!(key), json!(2), json!("c")));
    accept(&ws, "a", input("a3", 2, vec![edit_note(&key, "From the lead.")])).await;
    assert_eq!(written(&ws, &project, &key), ("a".into(), "Agent a".into(), "a".into(), 3));
}

/// YN-212 C1: a database from before authors: each row's author is filled
/// from its owner once, however often the migration runs; a row an older
/// Core writes later, with no author, reads as its owner's.
#[tokio::test]
async fn sections_written_before_authors_read_as_their_owners() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report")])).await;
    accept(&ws, "b", input("b1", 1, vec![put("state", "status")])).await;
    {
        let db = ws.store.db.write().unwrap();
        db.execute_batch("ALTER TABLE project_brief_sections DROP COLUMN author_id; ALTER TABLE project_brief_sections DROP COLUMN author_name;
            ALTER TABLE project_brief_sections DROP COLUMN author_version;").unwrap();
        migrate(&db).unwrap();
        migrate(&db).unwrap();
        let filled: i64 = db.query_row("SELECT COUNT(*) FROM project_brief_sections WHERE author_id=owner_id AND author_name=owner_name
            AND author_version=version", [], |r| r.get(0)).unwrap();
        assert_eq!(filled, 2);
        db.execute("UPDATE project_brief_sections SET author_id=NULL,author_name=NULL,author_version=NULL WHERE key='state'", []).unwrap();
    }
    assert_eq!(written(&ws, &project, "plan").2, "a");
    assert_eq!(section(&brief(&ws, "a"), "state")["author"], json!({"agentId":"b","name":"Agent b"}));
}

fn note_text(row: &sections::Row) -> Value {
    row.data["body"]["elements"]["note"]["props"]["text"].clone()
}

/// YN-212 C2: each write of a task's card keeps the version it replaces,
/// with its body and author, under the same identity: found by its version
/// (a link to it still opens it), listed on Home in the card's revisions,
/// newest first, left out of Home's History, and gone with history's days.
/// A section that is no task's card still changes in place.
#[tokio::test]
async fn a_tasks_card_keeps_each_version_its_writes_replace() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, internal) = task_in(&ws, &project, "Sign the release");
    let key = task.to_lowercase();
    role(&ws.store, "c", &internal, "agent:a", "d1", "running", None);
    accept(&ws, "a", input("a1", 0, vec![bound(&key, "status", &task), put("plan", "status")])).await;
    accept(&ws, "c", input("c1", 1, vec![edit_note(&key, "Signing: 3 of 5.")])).await;
    accept(&ws, "c", input("c2", 2, vec![json!({"op":"patch","key":key,"patch":[{"op":"replace","path":"/elements/note/props/text","value":"Signed."}]})])).await;
    accept(&ws, "a", input("a2", 3, vec![put(&key, "report"), edit_note("plan", "Plan B.")])).await;
    let identity = sections::live_key(&ws.store.db.read().unwrap(), &project, &key).unwrap().unwrap().identity;
    {
        let db = ws.store.db.read().unwrap();
        let kept = |version| sections::find(&db, &project, &key, Some(version)).unwrap().expect("kept");
        for (version, author, text) in [(1, "a", "Hello"), (2, "c", "Signing: 3 of 5."), (3, "c", "Signed.")] {
            let row = kept(version);
            assert_eq!((row.live, row.history_reason.as_deref(), row.identity, row.author_id.as_str(), row.kind.as_str(), note_text(&row)),
                (false, Some("revised"), identity, author, "status", json!(text)), "version {version}");
        }
        let live = sections::live_key(&db, &project, &key).unwrap().unwrap();
        assert_eq!((live.version, live.kind.as_str(), live.owner_id.as_str(), live.author_id.as_str()), (4, "report", "a", "a"));
        let plan: i64 = db.query_row("SELECT COUNT(*) FROM project_brief_sections WHERE key='plan'", [], |r| r.get(0)).unwrap();
        assert_eq!(plan, 1, "a section that is no task's card changes in place");
    }
    // The version route reads an earlier version whole.
    let old = crate::project_brief::refresh_writes::version(&ws.store, &project, identity, 2).unwrap().unwrap_or_else(|_| panic!("refused"));
    assert_eq!((old["version"].clone(), old["author"]["agentId"].clone(), old["historyReason"].clone()), (json!(2), json!("c"), json!("revised")));

    let home = panel(&ws);
    let shown = home["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap().clone();
    let listed: Vec<(Value, Value)> = shown["revisions"].as_array().unwrap().iter().map(|r| (r["version"].clone(), r["author"]["agentId"].clone())).collect();
    assert_eq!(listed, [(json!(3), json!("c")), (json!(2), json!("c")), (json!(1), json!("a"))]);
    assert_eq!(shown["id"], json!(identity), "the same section on Home");
    assert!(!keys(&home, "history").contains(&key), "History leaves the earlier versions out");
    let plan = home["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == "plan").unwrap();
    assert!(plan.get("revisions").is_none(), "{plan}");
    assert!(section(&brief(&ws, "a"), &key).get("revisions").is_none(), "brief_get stays as it was");

    // After history's days they go with the rest of history; the card stays.
    ws.store.db.write().unwrap().execute("UPDATE project_brief_sections SET history_at='2026-01-01T00:00:00Z' WHERE history_reason='revised'", []).unwrap();
    accept(&ws, "a", input("a3", 4, vec![edit_note("plan", "Plan C.")])).await;
    let left: i64 = ws.store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM project_brief_sections WHERE history_reason='revised'", [], |r| r.get(0)).unwrap();
    assert_eq!(left, 0);
    let after = panel(&ws);
    let shown = after["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap();
    assert!(shown.get("revisions").is_none() && shown["version"] == 4, "{shown}");
}

/// YN-212 C2: a card edited keeps showing its attachments: the new version
/// indexes the same snapshots, so collecting garbage leaves them, and the
/// earlier version reads its own by version. The card's end archives the
/// live version as before (YN-195), its earlier versions stay readable.
#[tokio::test]
async fn an_edited_card_keeps_its_attachments_and_its_end_archives_it_as_before() {
    let (dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let (task, _) = task_in(&ws, &project, "Sign the release");
    let key = task.to_lowercase();
    let file = dir.path().join("notes.txt");
    std::fs::write(&file, "signed files").unwrap();
    let mut card = bound(&key, "status", &task);
    card["attachments"] = attach(&file);
    accept(&ws, "a", input("a1", 0, vec![card])).await;
    accept(&ws, "a", input("a2", 1, vec![edit_note(&key, "Edited.")])).await;
    let cache = attachments::dir(&ws.data_dir);
    attachments::collect_garbage(&ws.store, &cache).unwrap();
    for version in [None, Some(1)] {
        let (path, _) = attachments::snapshot_file(&ws.store, &cache, &project, &key, "notes.txt", version).unwrap().ok().expect("kept");
        assert!(path.is_file(), "{version:?}");
    }
    task_set(&ws, &task, json!({"status":"done"}));
    assert_eq!(row(&ws, &project, &key), (false, Some("archived".into())), "its end archives the live version");
    let first = sections::find(&ws.store.db.read().unwrap(), &project, &key, Some(1)).unwrap().expect("kept");
    assert_eq!(first.history_reason.as_deref(), Some("revised"));
}

/// The lead's check (YN-212, seq 11728): this Core, then an older one, then
/// this one again. Lead b writes lead a's task card here (its author b).
/// An older Core, where only a card's owner writes it, edits it in place as
/// it does (update.rs before C1: a new version, owner_name, data and times;
/// the author columns, unknown to it, left as they were). Read here again,
/// that version is its owner's, not b's; the next version this Core writes
/// is its writer's again.
#[tokio::test]
async fn an_older_cores_edit_reads_as_its_owners_not_the_earlier_writers() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a", "b"]);
    let (task, _) = task_in(&ws, &project, "Sign the release");
    let key = task.to_lowercase();
    accept(&ws, "a", input("a1", 0, vec![bound(&key, "status", &task)])).await;
    accept(&ws, "b", input("b1", 1, vec![edit_note(&key, "Signing: 3 of 5.")])).await;
    assert_eq!(section(&brief(&ws, "a"), &key)["author"], json!({"agentId":"b","name":"Agent b"}));
    // The older Core's own edit, as it writes it.
    {
        let db = ws.store.db.write().unwrap();
        let (seq, version, data): (i64, i64, String) = db.query_row(
            "SELECT seq,version,data FROM project_brief_sections WHERE project_id=?1 AND key=?2 AND live=1", params![project, key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
        let mut data: Value = serde_json::from_str(&data).unwrap();
        data["body"]["elements"]["note"]["props"]["text"] = json!("Signed by the older Core.");
        db.execute("UPDATE project_brief_sections SET version=?2,owner_name=?3,data=?4,updated_at=?5,updated_turn_id=?6,
                     task_id=CASE WHEN ?7 THEN ?8 ELSE task_id END WHERE seq=?1",
            params![seq, version + 1, "Agent a", data.to_string(), crate::model::now(), Option::<String>::None, false, Option::<String>::None])
            .unwrap();
    }
    let shown = section(&brief(&ws, "a"), &key).clone();
    assert_eq!((shown["version"].clone(), shown["author"].clone()), (json!(3), json!({"agentId":"a","name":"Agent a"})),
        "the older Core's version is its owner's: {shown}");
    let home = panel(&ws);
    assert_eq!(section(&home["brief"], &key)["author"]["agentId"], "a", "on Home too");
    // This Core again (the Brief's version as the older Core left it): the next version is its writer's.
    accept(&ws, "b", input("b2", 2, vec![edit_note(&key, "Released.")])).await;
    assert_eq!(section(&brief(&ws, "a"), &key)["author"], json!({"agentId":"b","name":"Agent b"}));
    // C2: the versions it replaced keep their authors as read here, the older Core's as its owner's. Version 2,
    // which the older Core edited in place, is no row of its own any more: an older Core keeps no version it
    // replaces, so history has version 1 (a's) and version 3 (the older Core's, a's), not b's version 2.
    let revisions = section(&panel(&ws)["brief"], &key)["revisions"].clone();
    let authors: Vec<(Value, Value)> = revisions.as_array().unwrap().iter().map(|r| (r["version"].clone(), r["author"]["agentId"].clone())).collect();
    assert_eq!(authors, [(json!(3), json!("a")), (json!(1), json!("a"))], "{revisions}");
}
