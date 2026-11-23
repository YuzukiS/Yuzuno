//! YN-145 F6: a reply from Home carries the files the user attached on Home:
//! once Core knows who the reply goes to, it copies them from the Project's
//! files written on Home to that Agent's own and sends them with the message.
use super::*;
use sha2::{Digest, Sha256};

/// A file the user attached on Home in `project`, by its reference.
fn attached(ws: &Workspace, project: &str, n: u8, name: &str) -> crate::input_files::FileRef {
    let bytes = format!("synthetic file {n}").into_bytes();
    let id = format!("{:x}", Sha256::digest(&bytes));
    let dir = crate::input_files::home_dir(&ws.data_dir, project).unwrap();
    std::fs::create_dir_all(dir.join(&id)).unwrap();
    std::fs::write(dir.join(&id).join(name), &bytes).unwrap();
    crate::input_files::FileRef { id, name: name.into(), bytes: bytes.len() as u64 }
}

/// Whether `agent` has each of `files` as its own.
fn holds(ws: &Workspace, agent: &str, files: &[crate::input_files::FileRef]) -> bool {
    let dir = crate::input_files::agent_dir(&ws.data_dir, agent).unwrap();
    files.iter().all(|file| dir.join(&file.id).join(&file.name).is_file())
}

fn reply(agent: &str, text: &str, id: &str, files: &[crate::input_files::FileRef]) -> home::ReplyInput {
    home::ReplyInput { key: None, agent_id: agent.into(), text: text.into(), client_message_id: id.into(), choice: None,
        version: None, title: None, ask_version: None, workspace_id: None, form: None, images: vec![], files: files.to_vec(), intent: Default::default(), note: None }
}

fn card(agent: &str, text: &str, id: &str, files: &[crate::input_files::FileRef]) -> home::ReplyInput {
    home::ReplyInput { key: Some("news".into()), version: Some(1), title: Some("About news".into()), ..reply(agent, text, id, files) }
}

fn ask(ws: &Workspace, agent: &str, text: &str, id: &str, files: &[crate::input_files::FileRef]) -> home::ReplyInput {
    home::ReplyInput { key: Some("decide".into()), choice: Some("left".into()), ask_version: Some(1),
        workspace_id: Some(ws.store.workspace_id().unwrap()), ..reply(agent, text, id, files) }
}

#[tokio::test]
async fn a_card_an_ask_and_a_plain_reply_carry_their_files_to_the_agent_they_go_to() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("c1", 0, vec![put("news", "report"), put("decide", "ask")])).await;
    let files = vec![attached(&ws, &project, 1, "report.pdf"), attached(&ws, &project, 2, "notes.txt")];
    let sent = [("b", card("b", "Looks good", "r1", &files)), ("c", ask(&ws, "c", "Go", "r2", &files)), ("a", reply("a", "Hello", "r3", &files))];
    for (agent, said) in sent {
        let id = said.client_message_id.clone();
        let answer = home::reply(&ws, project.clone(), said).await;
        let receipt = ws.store.receipt(agent, &id).unwrap().unwrap_or_else(|| panic!("{id} was not sent: {:?}", answer.err()));
        assert_eq!(receipt.files, files, "{id}");
        assert!(holds(&ws, agent, &files), "{id}: copied to {agent}");
    }
    assert!(!ws.data_dir.join("input-files/d").exists(), "nobody else has them");
    // An ask's receipt says which files its reply carried; the answered ask
    // shows them.
    let origin = ws.store.receipt("c", "r2").unwrap().unwrap().origin.unwrap();
    assert_eq!(origin["reply"], home::reply_digest(Some("left"), "Go", None, &[], &files));
    assert_ne!(origin["reply"], home::reply_digest(Some("left"), "Go", None, &[], &[]));
    // The ask's answered version keeps the files it carried (a runtime's
    // delivery marks it; here none runs, so it is marked as other tests do).
    assert!(sections::mark_replied_form(&ws.store, &project, "decide", 1, "Left",
        sections::Marked { files: &files, ..Default::default() }).unwrap());
    let row = sections::find(&ws.store.db.read().unwrap(), &project, "decide", None).unwrap().unwrap();
    assert_eq!(row.reply_files, files, "kept with the version it answered");
    let shown = sections::section_json(&row, &sections::Owner { state: "active", name: "Agent a".into() }, None, json!([]), chrono::Utc::now());
    assert_eq!(shown["ask"]["replyFiles"], json!(files));
    // The same reply again is the one sent; with other files it is another message.
    let again = card("b", "Looks good", "r1", &files);
    assert_eq!(home::reply(&ws, project.clone(), again).await.unwrap().files, files);
    let error = home::reply(&ws, project.clone(), card("b", "Looks good", "r1", &files[..1])).await.unwrap_err();
    assert!(error.to_string().contains("already used for another message"), "{error}");
    // A form's reply takes files too (YN-213): it is checked as a form's, never refused for them. An Agent
    // that takes no files is refused.
    let mut formed = ask(&ws, "c", "Go", "r4", &files);
    (formed.choice, formed.form) = (None, Some(home::FormReply { form_id: "f".into(), answers: Default::default() }));
    let error = home::reply(&ws, project.clone(), formed).await.unwrap_err();
    assert!(error.to_string().starts_with("form_not_found:"), "{error}");
    ws.store.update("b", "test/harness", &json!({}), |d| d.agent.harness = "plain-text".into()).unwrap();
    let error = home::reply(&ws, project.clone(), card("b", "Looks good", "r5", &files)).await.unwrap_err();
    assert!(error.to_string().starts_with("files_unsupported: Agent b"), "{error}");
    assert!(ws.store.receipt("b", "r5").unwrap().is_none(), "nothing was sent");
}
