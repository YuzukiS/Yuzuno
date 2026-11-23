//! YN-223: a replied ask shows the user's newest delivered reply to that
//! version, in the order Core accepted their messages (their receipts): when
//! a delivered reply's mark was interrupted, when two windows' marks land in
//! the other order, and on a version replied before Core kept which reply it
//! shows. Whatever it shows is one reply's choice, words, images and files
//! together, on Home and in its History entry.
use super::*;
use sha2::{Digest, Sha256};

/// A reply the user gave to version `version` of the ask `decide`: what it chose, said and attached.
struct Said {
    client: &'static str,
    version: i64,
    choice: &'static str,
    label: &'static str,
    text: &'static str,
    images: Vec<String>,
    files: Vec<crate::input_files::FileRef>,
}

/// The user's reply `n` to `version`: its own image and file.
fn said(ws: &Workspace, project: &str, client: &'static str, version: i64, choice: &'static str, text: &'static str, n: u8) -> Said {
    let bytes = format!("synthetic image {n}").into_bytes();
    let image = format!("{:x}.png", Sha256::digest(&bytes));
    let images = crate::input_images::home_dir(&ws.data_dir, project).unwrap();
    std::fs::create_dir_all(&images).unwrap();
    std::fs::write(images.join(&image), &bytes).unwrap();
    std::fs::write(images.join(format!("{image}.thumb.png")), b"synthetic thumbnail").unwrap();
    let bytes = format!("synthetic file {n}").into_bytes();
    let id = format!("{:x}", Sha256::digest(&bytes));
    let files = crate::input_files::home_dir(&ws.data_dir, project).unwrap().join(&id);
    std::fs::create_dir_all(&files).unwrap();
    std::fs::write(files.join(format!("notes-{n}.txt")), &bytes).unwrap();
    let file = crate::input_files::FileRef { id, name: format!("notes-{n}.txt"), bytes: bytes.len() as u64 };
    let label = if choice == "left" { "Left" } else { "Right" };
    Said { client, version, choice, label, text, images: vec![image], files: vec![file] }
}

/// Home's send of `said` to the ask's owner a.
fn input_of(ws: &Workspace, said: &Said) -> home::ReplyInput {
    home::ReplyInput { key: Some("decide".into()), agent_id: "a".into(), text: said.text.into(), client_message_id: said.client.into(),
        choice: Some(said.choice.into()), version: None, title: None, ask_version: Some(said.version),
        workspace_id: Some(ws.store.workspace_id().unwrap()), form: None, images: said.images.clone(), files: said.files.clone(),
        intent: Default::default(), note: None }
}

/// Core accepted `said` (`status`), and nothing marked the ask for it: as when Core stopped after its send and
/// before its mark. Receipts are written in the order Core accepts messages, under the Agent's send lock.
fn sent(ws: &Workspace, project: &str, said: &Said, status: &str, note: bool) {
    let workspace = ws.store.workspace_id().unwrap();
    let row = sections::find(&ws.store.db.read().unwrap(), project, "decide", Some(said.version)).unwrap().unwrap();
    let mut input = input_of(ws, said);
    let mut origin = json!({"kind":"home","projectId":project,"key":"decide","version":said.version,"sectionId":row.identity,
        "workspaceId":workspace});
    if note {
        (input.choice, input.intent) = (None, home::ReplyIntent::Note);
        origin["intent"] = json!("note");
    }
    origin["reply"] = json!(home::input_digest(&input));
    let chosen = (!note).then(|| (said.choice.to_owned(), said.label.to_owned()));
    let receipt = crate::model::MessageReceipt { binding: None, files: said.files.clone(), file_paths: vec![], skills: vec![],
        status: status.into(), turn_id: Some("t1".into()), error: None, origin: Some(origin),
        input: crate::model::MessageInput { client_message_id: said.client.into(),
            text: home::compose_ask(&workspace, "Code", project, &row, chosen.as_ref(), said.text), text_blocks: None,
            images: said.images.clone(), expected_turn_id: Some("t1".into()), question: None, clarification: None } };
    ws.store.update_meta("a", "message/requested", &json!({}), move |m| m.message_receipts.push(receipt)).unwrap();
}

/// Home's retry of `said`, whose send Core accepted before: it answers with that receipt and marks the ask, if it
/// is the newest reply delivered.
async fn retried(ws: &Arc<Workspace>, project: &str, said: &Said) {
    let receipt = home::reply(ws, project.to_owned(), input_of(ws, said)).await.unwrap();
    assert_eq!(receipt.status, "accepted", "{} answers with its first send's receipt", said.client);
}

/// The mark a send that Core accepted just now makes (a lab runs no runtime to deliver one).
fn marked_fresh(ws: &Workspace, project: &str, said: &Said) -> bool {
    let words = format!("{}: {}", said.label, said.text);
    let given = given(said);
    sections::mark_replied_form(&ws.store, project, "decide", said.version, &words, sections::Marked {
        images: &said.images, files: &said.files, snapshot: Some(&given),
        sent: Some(sections::Sent { agent: "a", client: said.client, fresh: true }), ..Default::default()
    }).unwrap()
}

/// `said` as Home's answered ask shows it.
fn given(said: &Said) -> Value {
    json!({"format":1,"projectName":"Code","sectionKind":"ask","title":"About decide","question":"Which way?",
        "options":[{"id":"left","label":"Left"},{"id":"right","label":"Right"}],"choice":{"id":said.choice,"label":said.label},
        "text":said.text,"form":null})
}

fn on_home(ws: &Workspace) -> Value {
    let home = home::build(&ws.store).unwrap();
    home["projects"][0]["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == "decide").expect("on Home")["ask"].clone()
}

/// The ask shows `said` whole, and nothing of another reply: its choice among the options it offered, its words,
/// its images and files.
#[track_caller]
fn shows(ask: &Value, said: &Said, snapshot: bool) {
    assert_eq!(ask["state"], "replied", "{ask}");
    assert_eq!(ask["replyText"], format!("{}: {}", said.label, said.text), "{ask}");
    assert_eq!(ask["replyImages"], json!(said.images), "{ask}");
    assert_eq!(ask["replyFiles"], json!(said.files), "{ask}");
    if snapshot {
        assert_eq!(ask["replySnapshot"], given(said), "{ask}");
    } else {
        assert!(ask.get("replySnapshot").is_none(), "{ask}");
    }
}

/// Which message the replied version shows, as Core recorded it.
fn recorded(ws: &Workspace, project: &str) -> (Option<String>, Option<String>) {
    ws.store.db.read().unwrap().query_row(
        "SELECT reply_agent,reply_client FROM project_brief_sections WHERE project_id=?1 AND key='decide' AND live=1",
        [project], |r| Ok((r.get(0)?, r.get(1)?))).unwrap()
}

/// A reply Core delivered, then stopped before marking the ask for it: its retry marks it over the earlier reply the
/// ask showed, and no later retry of that earlier reply takes it back.
#[tokio::test]
async fn a_delivered_reply_whose_mark_was_interrupted_marks_the_ask_when_retried() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("q1", 0, vec![put("decide", "ask")])).await;
    let first = said(&ws, &project, "m1", 1, "left", "Go", 1);
    let then = said(&ws, &project, "m2", 1, "right", "On second thought", 2);
    sent(&ws, &project, &first, "accepted", false);
    retried(&ws, &project, &first).await;
    shows(&on_home(&ws), &first, true);
    // The second reply reached the Agent; its mark never ran.
    sent(&ws, &project, &then, "accepted", false);
    shows(&on_home(&ws), &first, true);
    retried(&ws, &project, &then).await;
    shows(&on_home(&ws), &then, true);
    assert_eq!(recorded(&ws, &project), (Some("a".into()), Some("m2".into())));
    // A late retry of the first reply, then the second's again: the second stays, whole.
    retried(&ws, &project, &first).await;
    shows(&on_home(&ws), &then, true);
    retried(&ws, &project, &then).await;
    shows(&on_home(&ws), &then, true);
}

/// Two windows' replies, accepted one after the other, mark the ask in the other order: the one accepted last stays,
/// fresh or retried, on Home and once resolved in its History entry, read whole or opened from the index.
#[tokio::test]
async fn marks_landing_in_the_other_order_keep_the_reply_accepted_last() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("q1", 0, vec![put("decide", "ask")])).await;
    let one = said(&ws, &project, "w1", 1, "left", "From the first window", 1);
    let two = said(&ws, &project, "w2", 1, "right", "From the second window", 2);
    sent(&ws, &project, &one, "accepted", false);
    sent(&ws, &project, &two, "accepted", false);
    // The second window's mark first, then the first's, as a send made just now and as its retry.
    assert!(marked_fresh(&ws, &project, &two));
    assert!(!marked_fresh(&ws, &project, &one), "accepted before the reply the ask shows");
    retried(&ws, &project, &one).await;
    shows(&on_home(&ws), &two, true);
    // A reply sent after both marks it, made just now or retried.
    let three = said(&ws, &project, "w3", 1, "left", "Settled", 3);
    sent(&ws, &project, &three, "accepted", false);
    assert!(marked_fresh(&ws, &project, &three));
    shows(&on_home(&ws), &three, true);
    retried(&ws, &project, &two).await;
    shows(&on_home(&ws), &three, true);
    // Resolved, its History entry keeps the same reply, as Home read whole and as the entry opened from the index.
    accept(&ws, "a", input("q2", 1, vec![op("resolve", "decide")])).await;
    let full = home::build(&ws.store).unwrap();
    let entry = full["projects"][0]["brief"]["history"].as_array().unwrap().iter().find(|e| e["key"] == "decide").unwrap().clone();
    assert_eq!((entry["ask"]["state"].clone(), entry["ask"]["replyText"].clone()), (json!("resolved"), json!("Left: Settled")));
    assert_eq!(entry["ask"]["replySnapshot"], given(&three));
    assert_eq!((entry["ask"]["replyImages"].clone(), entry["ask"]["replyFiles"].clone()), (json!(three.images), json!(three.files)));
    let index = home::build_with(&ws.store, home::History::Index).unwrap();
    let listed = index["projects"][0]["brief"]["history"].as_array().unwrap().iter().find(|e| e["key"] == "decide").unwrap().clone();
    let read = home::history_entries(&ws.store, &project, &[(listed["id"].as_i64().unwrap(), listed["version"].as_i64().unwrap())]).unwrap();
    assert_eq!(read["entries"][0], entry, "opened from the index, as Home read whole shows it");
}

/// A version an older Core marked, without saying which message it shows: its receipts place it by the newest other
/// reply delivered to it (never a note, nor a send not delivered), so a late retry of an earlier reply keeps the
/// newer answer. Where they place nothing, the answer it shows is kept from a retry, and a reply sent just now marks it.
#[tokio::test]
async fn a_version_an_older_core_marked_keeps_its_answer_from_an_earlier_replys_retry() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("q1", 0, vec![put("decide", "ask")])).await;
    let early = said(&ws, &project, "o1", 1, "left", "Go", 1);
    let late = said(&ws, &project, "o2", 1, "right", "Wait", 2);
    sent(&ws, &project, &early, "accepted", false);
    sent(&ws, &project, &late, "accepted", false);
    // After both: a note, and a send Core refused.
    sent(&ws, &project, &said(&ws, &project, "o3", 1, "left", "A note", 3), "accepted", true);
    sent(&ws, &project, &said(&ws, &project, "o4", 1, "left", "Refused", 4), "rejected", false);
    // The older Core marked the later reply, as replies were marked before it kept snapshots or messages.
    assert!(sections::mark_replied_form(&ws.store, &project, "decide", 1, "Right: Wait", sections::Marked {
        images: &late.images, files: &late.files, ..Default::default() }).unwrap());
    assert_eq!(recorded(&ws, &project), (None, None));
    shows(&on_home(&ws), &late, false);
    retried(&ws, &project, &early).await;
    shows(&on_home(&ws), &late, false);
    // The later reply's own retry is placed after the earlier one, and marks it as given.
    retried(&ws, &project, &late).await;
    shows(&on_home(&ws), &late, true);
    assert_eq!(recorded(&ws, &project), (Some("a".into()), Some("o2".into())));
    retried(&ws, &project, &early).await;
    shows(&on_home(&ws), &late, true);
    // Asked again, the older Core marks the new version with a reply no receipt has: a delivered reply's retry
    // can't be placed against it, and leaves it as it is.
    accept(&ws, "a", input("q2", 1, vec![put("decide", "ask")])).await;
    let unplaced = said(&ws, &project, "gone", 2, "left", "Before the receipts", 5);
    let retry = said(&ws, &project, "o5", 2, "right", "Retried", 6);
    sent(&ws, &project, &retry, "accepted", false);
    assert!(sections::mark_replied_form(&ws.store, &project, "decide", 2, "Left: Before the receipts", sections::Marked {
        images: &unplaced.images, files: &unplaced.files, ..Default::default() }).unwrap());
    retried(&ws, &project, &retry).await;
    shows(&on_home(&ws), &unplaced, false);
    // Asked again and marked so once more: a reply Core accepted just now is newer than the one it shows.
    accept(&ws, "a", input("q3", 2, vec![put("decide", "ask")])).await;
    let unplaced = said(&ws, &project, "gone", 3, "left", "Before the receipts", 5);
    assert!(sections::mark_replied_form(&ws.store, &project, "decide", 3, "Left: Before the receipts", sections::Marked {
        images: &unplaced.images, files: &unplaced.files, ..Default::default() }).unwrap());
    let now = said(&ws, &project, "o6", 3, "right", "Sent now", 7);
    sent(&ws, &project, &now, "accepted", false);
    assert!(marked_fresh(&ws, &project, &now));
    shows(&on_home(&ws), &now, true);
}
