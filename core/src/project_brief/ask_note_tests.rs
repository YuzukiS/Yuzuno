//! YN-213: Home's "Wait, what?" sends a note on an ask: the user's words,
//! images and files to the ask's Agent, without answering it. The ask stays
//! open in Needs you at the version the note was written on, the note is
//! kept apart from any reply, and the Agent's message says it is not an
//! answer. A form's answers, in turn, go with the user's own note and what
//! they attached, as one reply.
use super::*;
use crate::project_brief::ask_notes;
use sha2::{Digest, Sha256};

fn note(ws: &Workspace, agent: &str, text: &str, id: &str) -> home::ReplyInput {
    home::ReplyInput { key: Some("decide".into()), agent_id: agent.into(), text: text.into(), client_message_id: id.into(), choice: None,
        version: None, title: None, ask_version: Some(1), workspace_id: Some(ws.store.workspace_id().unwrap()), form: None, images: vec![],
        files: vec![], intent: home::ReplyIntent::Note, note: None }
}

fn refused(error: anyhow::Error, code: &str) {
    assert!(error.to_string().starts_with(code), "{error}");
    assert!(error.is::<crate::collaboration_credentials::MessageNotSubmitted>(), "nothing was sent: {error}");
}

/// An image the user attached on Home in `project`, by its ID.
fn attached(ws: &Workspace, project: &str, n: u8) -> String {
    let bytes = format!("synthetic image {n}").into_bytes();
    let id = format!("{:x}.png", Sha256::digest(&bytes));
    let dir = crate::input_images::home_dir(&ws.data_dir, project).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&id), &bytes).unwrap();
    std::fs::write(dir.join(format!("{id}.thumb.png")), b"synthetic thumbnail").unwrap();
    id
}

/// What Core sent first under `input`'s client ID, accepted: as Home's
/// first send that reached the Agent, so its retry finds it delivered.
fn delivered_before(ws: &Workspace, project: &str, input: &home::ReplyInput, text: String) {
    let mut origin = json!({"kind":"home","projectId":project,"key":input.key,"version":input.ask_version,
        "workspaceId":input.workspace_id,"reply":home::input_digest(input)});
    if input.intent == home::ReplyIntent::Note {
        origin["intent"] = json!("note");
    }
    let sent = crate::model::MessageReceipt { binding: None, files: input.files.clone(), file_paths: vec![], skills: vec![],
        status: "accepted".into(), turn_id: Some("t1".into()), error: None, origin: Some(origin),
        input: crate::model::MessageInput { client_message_id: input.client_message_id.clone(), text, text_blocks: None,
            images: input.images.clone(), expected_turn_id: Some("t1".into()), question: None, clarification: None } };
    ws.store.update_meta(&input.agent_id, "message/requested", &json!({}), move |m| m.message_receipts.push(sent)).unwrap();
}

/// The ask under `key` as Home shows it.
fn home_ask(ws: &Workspace, key: &str) -> Value {
    let panel = &home::build(&ws.store).unwrap()["projects"][0];
    panel["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).expect("on Home")["ask"].clone()
}

fn needs_you(ws: &Workspace, key: &str) -> bool {
    home::build(&ws.store).unwrap()["needsYou"].as_array().unwrap().iter().any(|n| n["kind"] == "ask" && n["sectionKey"] == key)
}

#[tokio::test]
async fn a_note_reaches_the_asks_agent_says_it_answers_nothing_and_leaves_the_ask_open() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("q1", 0, vec![put("decide", "ask")])).await;
    let workspace = ws.store.workspace_id().unwrap();
    let row = sections::live_key(&ws.store.db.read().unwrap(), &project, "decide").unwrap().unwrap();

    // The message: which version of which ask it is about, the words, and that it is not an answer.
    let message = home::compose_note(&workspace, "Code", &project, &row, "The preview won't open; send a screenshot first?");
    assert!(message.starts_with(&format!("Note from the user on Home, about version 1 of the Project Brief section `decide` (\"About decide\") \
        of Code (Workspace {workspace}, Project {project}):\n> Which way?\n\nThe preview won't open; send a screenshot first?\n")), "{message}");
    assert!(message.contains("This note is not an answer") && message.contains("approved nothing")
        && message.contains("stays open in their Needs you at version 1") && message.contains("Act on none of its options as chosen"), "{message}");
    assert!(!message.contains("now replied") && !message.contains("Chose:"), "{message}");
    // Images alone: said so, never an empty line.
    assert!(home::compose_note(&workspace, "Code", &project, &row, "  ").contains("\n(No words: see what the note attached.)\n"));

    // Sent first: its receipt says it is a note, and what the user saw. (Whether the lab's Agent takes it is not this test's.)
    let _ = home::reply(&ws, project.clone(), note(&ws, "b", "Is this the right preview?", "n0")).await;
    let receipt = ws.store.receipt("b", "n0").unwrap().expect("sent");
    assert_eq!(receipt.input.text, home::compose_note(&workspace, "Code", &project, &row, "Is this the right preview?"));
    let origin = receipt.origin.unwrap();
    assert_eq!(origin["intent"], "note");
    assert_eq!(origin["home"], snapshot(json!({"sectionKind":"ask","title":"About decide","question":"Which way?","options":two_ways(),
        "text":"Is this the right preview?"})));
    // In the conversation it shows as a note from Home.
    let shown = crate::input_origin::home_reply_for_test(&serde_json::to_string(&origin).unwrap()).unwrap();
    assert_eq!(shown["intent"], "note");

    // Delivered: kept as a note, once, and the ask is as it was: open, in Needs you, no reply.
    let sent = note(&ws, "b", "The preview won't open; send a screenshot first?", "n1");
    delivered_before(&ws, &project, &sent, message.clone());
    for _ in 0..2 {
        let receipt = home::reply(&ws, project.clone(), note(&ws, "b", "The preview won't open; send a screenshot first?", "n1")).await.unwrap();
        assert_eq!((receipt.status.as_str(), receipt.input.text.as_str()), ("accepted", message.as_str()));
    }
    let ask = home_ask(&ws, "decide");
    assert_eq!(ask["state"], "open");
    assert!(ask.get("replyText").is_none() && ask.get("repliedAt").is_none(), "{ask}");
    let notes: Vec<&Value> = ask["notes"].as_array().expect("its notes").iter()
        .filter(|n| n["text"] == "The preview won't open; send a screenshot first?").collect();
    assert_eq!(notes.len(), 1, "a retry keeps one note: {ask}");
    assert_eq!((notes[0]["version"].clone(), notes[0]["agentId"].clone()), (json!(1), json!("b")));
    assert!(needs_you(&ws, "decide"));
    assert_eq!(section(&brief(&ws, "a"), "decide")["ask"]["state"], "open", "Agents read it open too");
    assert!(brief(&ws, "a")["you"]["repliedAsks"].as_array().is_none_or(|asks| asks.is_empty()));

    // Answered after the note: replied as ever, its notes still listed beside the reply.
    let mut answer = note(&ws, "b", "", "r1");
    (answer.intent, answer.choice) = (home::ReplyIntent::Answer, Some("left".into()));
    delivered_before(&ws, &project, &answer, home::compose_ask(&workspace, "Code", &project, &row, home::choice(&row, "left").as_ref(), ""));
    home::reply(&ws, project.clone(), answer).await.unwrap();
    let ask = home_ask(&ws, "decide");
    assert_eq!((ask["state"].clone(), ask["replyText"].clone()), (json!("replied"), json!("Left")));
    assert!(ask["notes"].as_array().is_some_and(|notes| !notes.is_empty()), "{ask}");
    assert!(!needs_you(&ws, "decide"));

    // A note on a replied ask keeps it replied, with its reply.
    let later = note(&ws, "b", "One more thing", "n2");
    delivered_before(&ws, &project, &later, home::compose_note(&workspace, "Code", &project, &row, "One more thing"));
    home::reply(&ws, project.clone(), later).await.unwrap();
    let ask = home_ask(&ws, "decide");
    assert_eq!((ask["state"].clone(), ask["replyText"].clone()), (json!("replied"), json!("Left")));
    assert_eq!(ask["notes"][0]["text"], "One more thing", "newest first: {ask}");
}

#[tokio::test]
async fn a_note_answers_nothing_and_a_note_and_an_answer_are_different_messages() {
    let (_dir, ws, project) = lab();
    let mut setup = put("setup", "ask");
    setup["ask"]["reply"] = json!({"form":{"id":"prefs","title":"Preview setup","fields":[
        {"id":"theme","type":"single","label":"Theme","required":true,"options":[{"id":"light","label":"Light"},{"id":"dark","label":"Dark"}]}]}});
    accept(&ws, "a", input("q1", 0, vec![put("decide", "ask"), put("news", "report"), setup])).await;
    // Never with a choice or a form's answers, never empty, never to a card or without the ask's version.
    let mut chose = note(&ws, "b", "Go", "x1");
    chose.choice = Some("left".into());
    let mut formed = note(&ws, "b", "Answers", "x2");
    (formed.key, formed.form) = (Some("setup".into()), Some(serde_json::from_value(json!({"formId":"prefs","answers":{"theme":"dark"}})).unwrap()));
    let empty = note(&ws, "b", "  ", "x3");
    let mut card = note(&ws, "b", "Hm", "x4");
    (card.key, card.ask_version, card.workspace_id, card.version, card.title) = (Some("news".into()), None, None, Some(1), Some("About news".into()));
    let mut unversioned = note(&ws, "b", "Hm", "x5");
    (unversioned.key, unversioned.ask_version, unversioned.workspace_id) = (Some("news".into()), None, None);
    for (said, why) in [(chose, "A note answers nothing"), (formed, "A note answers nothing"), (empty, "Write a note"),
        (card, "A note goes to an ask"), (unversioned, "A note goes with the version")] {
        let id = said.client_message_id.clone();
        let error = home::reply(&ws, project.clone(), said).await.unwrap_err();
        assert!(error.to_string().starts_with(why), "{id}: {error}");
        assert!(ws.store.receipt("b", &id).unwrap().is_none(), "{id}: nothing was sent");
    }
    // A form's note is a form's only: beside a choice the reply's text is the user's words.
    let mut beside = note(&ws, "b", "Go", "x6");
    (beside.intent, beside.choice, beside.note) = (home::ReplyIntent::Answer, Some("left".into()), Some("and quickly".into()));
    assert!(home::reply(&ws, project.clone(), beside).await.unwrap_err().to_string().starts_with("A note beside the answers goes with a form's answers"));

    // The same words as a note and as an answer digest apart; one without either digests as before.
    let words = note(&ws, "b", "Left, I think", "x7");
    let mut answer = note(&ws, "b", "Left, I think", "x7");
    answer.intent = home::ReplyIntent::Answer;
    assert_ne!(home::input_digest(&words), home::input_digest(&answer));
    assert_eq!(home::input_digest(&answer), home::reply_digest(None, "Left, I think", None, &[], &[]));
    // A client ID a note was sent under is not an answer's, nor the other way round.
    let _ = home::reply(&ws, project.clone(), words).await;
    assert!(ws.store.receipt("b", "x7").unwrap().is_some());
    let error = home::reply(&ws, project.clone(), answer).await.unwrap_err();
    assert!(error.to_string().contains("already used for another message"), "{error}");
    // A note to a version Home no longer has sends nothing, as a reply does.
    accept(&ws, "a", input("q2", version(&ws, &project), vec![put("decide", "ask")])).await;
    refused(home::reply(&ws, project.clone(), note(&ws, "b", "Hm", "x8")).await.unwrap_err(), "ask_changed");
    assert!(ws.store.receipt("b", "x8").unwrap().is_none());
}

#[tokio::test]
async fn a_forms_answers_go_with_the_users_note_and_images_as_one_reply() {
    let (_dir, ws, project) = lab();
    let mut setup = put("setup", "ask");
    setup["ask"]["reply"] = json!({"form":{"id":"prefs","title":"Preview setup","fields":[
        {"id":"theme","type":"single","label":"Theme","required":true,"options":[{"id":"light","label":"Light"},{"id":"dark","label":"Dark"}]}]}});
    accept(&ws, "a", input("q1", 0, vec![setup])).await;
    let workspace = ws.store.workspace_id().unwrap();
    let row = sections::live_key(&ws.store.db.read().unwrap(), &project, "setup").unwrap().unwrap();
    let text = "Answers to \u{201c}Preview setup\u{201d}:\n- Theme: Dark\n\n{\"formId\":\"prefs\",\"answers\":{\"theme\":\"dark\"}}".to_owned();
    let images = vec![attached(&ws, &project, 1)];
    let answer = |id: &str| home::ReplyInput { key: Some("setup".into()), agent_id: "b".into(), text: text.clone(), client_message_id: id.into(),
        choice: None, version: None, title: None, ask_version: Some(1), workspace_id: Some(workspace.clone()),
        form: Some(serde_json::from_value(json!({"formId":"prefs","answers":{"theme":"dark"}})).unwrap()), images: images.clone(), files: vec![],
        intent: home::ReplyIntent::Answer, note: Some("  Dark, once the preview is fixed.  ".into()) };

    // One message: the answers, then the user's note, with the image; the ask is replied as ever.
    let message = home::compose_answer(&workspace, "Code", &project, &row, None, &text, Some("Dark, once the preview is fixed."));
    assert!(message.contains(&format!("\n{text}\n\nWith these answers, the user wrote:\nDark, once the preview is fixed.\n\nThe ask is now replied")), "{message}");
    let _ = home::reply(&ws, project.clone(), answer("f0")).await;
    let receipt = ws.store.receipt("b", "f0").unwrap().expect("sent, not refused for its image");
    assert_eq!((receipt.input.text.as_str(), &receipt.input.images), (message.as_str(), &images));
    let origin = receipt.origin.unwrap();
    assert!(origin.get("intent").is_none());
    assert_eq!(origin["home"]["text"], "Dark, once the preview is fixed.", "the snapshot's words are the note");
    assert_eq!(origin["home"]["form"]["fields"][0]["answer"], "Dark");

    // Delivered: replied, its text the answers and the note, its image shown with it.
    delivered_before(&ws, &project, &answer("f1"), message.clone());
    home::reply(&ws, project.clone(), answer("f1")).await.unwrap();
    let ask = home_ask(&ws, "setup");
    assert_eq!((ask["state"].clone(), ask["replyText"].clone(), ask["replyImages"].clone()),
        (json!("replied"), json!(format!("{text}\n\nDark, once the preview is fixed.")), json!(images)));
    assert!(ask.get("notes").is_none(), "an answer's note is the reply's, not a note on the ask");

    // The answers' note counts toward the reply's length.
    let mut long = answer("f2");
    long.note = Some("x".repeat(home::MAX_REPLY - text.len() + 1));
    refused(home::reply(&ws, project.clone(), long).await.unwrap_err(), "reply_too_long");
}

/// Notes are listed newest first, at most NOTES_SHOWN of an ask, and go once
/// no row keeps the ask they were written on.
#[tokio::test]
async fn an_asks_notes_are_listed_newest_first_and_go_with_the_ask() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("q1", 0, vec![put("decide", "ask")])).await;
    let identity = identity(&ws, &project, "decide");
    for n in 0..ask_notes::NOTES_SHOWN + 2 {
        let (id, text) = (format!("n{n}"), format!("Note {n}"));
        assert!(ask_notes::record(&ws.store, &ask_notes::Note { agent: "b", client_message_id: &id, project: &project, key: "decide",
            identity, version: 1, text: &text, images: &[], files: &[] }).unwrap());
    }
    let shown = home_ask(&ws, "decide")["notes"].as_array().unwrap().iter().map(|n| n["text"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    assert_eq!(shown, (2..ask_notes::NOTES_SHOWN + 2).rev().map(|n| format!("Note {n}")).collect::<Vec<_>>());
    // The same message again keeps nothing more.
    assert!(!ask_notes::record(&ws.store, &ask_notes::Note { agent: "b", client_message_id: "n0", project: &project, key: "decide",
        identity, version: 1, text: "Note 0", images: &[], files: &[] }).unwrap());
    // Kept while a row keeps the ask, history included; gone with it.
    let count = |ws: &Workspace| rows(ws, "SELECT COUNT(*) FROM project_brief_ask_notes");
    sections::expire_history(&ws.store.db.write().unwrap()).unwrap();
    assert_eq!(count(&ws), ask_notes::NOTES_SHOWN as i64 + 2);
    ws.store.db.write().unwrap().execute("DELETE FROM project_brief_sections WHERE seq=?1", [identity]).unwrap();
    sections::expire_history(&ws.store.db.write().unwrap()).unwrap();
    assert_eq!(count(&ws), 0);
}
