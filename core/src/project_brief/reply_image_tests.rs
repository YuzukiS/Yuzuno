//! YN-134 S2a: a reply from Home carries the images the user attached on
//! Home: once Core knows who the reply goes to, it copies them from the
//! Project's images written on Home to that Agent's own and sends them with
//! the message, as a conversation does.
use super::*;
use sha2::{Digest, Sha256};

/// An image the user attached on Home in `project`, by its ID: content
/// addressed, with its thumbnail, as the Project's image route keeps one.
fn attached(ws: &Workspace, project: &str, n: u8) -> String {
    let bytes = format!("synthetic image {n}").into_bytes();
    let id = format!("{:x}.png", Sha256::digest(&bytes));
    let dir = crate::input_images::home_dir(&ws.data_dir, project).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&id), &bytes).unwrap();
    std::fs::write(dir.join(format!("{id}.thumb.png")), b"synthetic thumbnail").unwrap();
    id
}

/// Whether `agent` has each of `images` as its own.
fn holds(ws: &Workspace, agent: &str, images: &[String]) -> bool {
    images.iter().all(|id| crate::input_images::image_path(&ws.data_dir, agent, id).unwrap().is_file())
}

fn reply(agent: &str, text: &str, id: &str, images: &[String]) -> home::ReplyInput {
    home::ReplyInput { key: None, agent_id: agent.into(), text: text.into(), client_message_id: id.into(), choice: None,
        version: None, title: None, ask_version: None, workspace_id: None, form: None, images: images.to_vec() }
}

fn card(agent: &str, text: &str, id: &str, images: &[String]) -> home::ReplyInput {
    home::ReplyInput { key: Some("news".into()), version: Some(1), title: Some("About news".into()), ..reply(agent, text, id, images) }
}

fn ask(ws: &Workspace, agent: &str, text: &str, id: &str, images: &[String]) -> home::ReplyInput {
    home::ReplyInput { key: Some("decide".into()), choice: Some("left".into()), ask_version: Some(1),
        workspace_id: Some(ws.store.workspace_id().unwrap()), ..reply(agent, text, id, images) }
}

fn refused(error: anyhow::Error, code: &str) {
    assert!(error.to_string().starts_with(code), "{error}");
    assert!(error.is::<crate::collaboration_credentials::MessageNotSubmitted>(), "nothing was sent: {error}");
}

#[tokio::test]
async fn a_card_an_ask_and_a_plain_reply_carry_their_images_to_the_agent_they_go_to() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("c1", 0, vec![put("news", "report"), put("decide", "ask")])).await;
    let images = vec![attached(&ws, &project, 1), attached(&ws, &project, 2)];
    let sent = [("b", card("b", "Looks good", "r1", &images)), ("c", ask(&ws, "c", "Go", "r2", &images)), ("a", reply("a", "Hello", "r3", &images))];
    for (agent, said) in sent {
        let id = said.client_message_id.clone();
        let answer = home::reply(&ws, project.clone(), said).await;
        let receipt = ws.store.receipt(agent, &id).unwrap().unwrap_or_else(|| panic!("{id} was not sent: {:?}", answer.err()));
        assert_eq!(receipt.input.images, images, "{id}");
        assert!(holds(&ws, agent, &images), "{id}: copied to {agent}, under the same IDs");
    }
    assert!(!ws.data_dir.join("input-images/d").exists(), "nobody else has them");
    // An ask's receipt says which images its reply carried.
    let origin = ws.store.receipt("c", "r2").unwrap().unwrap().origin.unwrap();
    assert_eq!(origin["reply"], home::reply_digest(Some("left"), "Go", None, &images));
    assert_ne!(origin["reply"], home::reply_digest(Some("left"), "Go", None, &[]));

    // The same reply again is the one sent; with other images it is another message.
    for (agent, again) in [("b", card("b", "Looks good", "r1", &images)), ("c", ask(&ws, "c", "Go", "r2", &images)), ("a", reply("a", "Hello", "r3", &images))] {
        let id = again.client_message_id.clone();
        let receipt = home::reply(&ws, project.clone(), again).await.unwrap_or_else(|error| panic!("{id}: {error}"));
        assert_eq!(receipt.input.images, images, "{id}");
        assert_eq!(ws.store.receipt(agent, &id).unwrap().unwrap().input.images, images);
    }
    let fewer = &images[..1];
    for other in [card("b", "Looks good", "r1", fewer), ask(&ws, "c", "Go", "r2", fewer), reply("a", "Hello", "r3", fewer),
        reply("a", "Hello", "r3", &[])] {
        let id = other.client_message_id.clone();
        let error = home::reply(&ws, project.clone(), other).await.unwrap_err();
        assert!(error.to_string().contains("already used for another message"), "{id}: {error}");
    }
}

/// A reply meant for a released executor goes to whoever answers for the
/// section now (reply_target), and so do its images.
#[tokio::test]
async fn the_images_go_to_the_agent_the_reply_is_handed_to() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a", "b"]);
    ws.store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,project_id,template_id,created_by,created_at,updated_at)
         VALUES('c','executor',?1,'reviewer','agent:a','now','now')", [&project]).unwrap();
    accept(&ws, "c", input("ask", 0, vec![put("decide", "ask")])).await;
    ws.release_executor(Some("a"), "c").await.unwrap();
    let images = vec![attached(&ws, &project, 1)];
    let answer = home::reply(&ws, project.clone(), ask(&ws, "c", "", "r1", &images)).await;
    let receipt = ws.store.receipt("a", "r1").unwrap().unwrap_or_else(|| panic!("not handed to the dispatcher: {:?}", answer.err()));
    assert_eq!(receipt.input.images, images);
    assert!(holds(&ws, "a", &images), "copied to the dispatcher");
    assert!(ws.store.receipt("c", "r1").unwrap().is_none() && !ws.data_dir.join("input-images/c").exists(), "not to the released executor");
}

#[tokio::test]
async fn a_reply_whose_images_cant_go_sends_nothing() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("c1", 0, vec![put("news", "report"), put("decide", "ask")])).await;
    let images = vec![attached(&ws, &project, 1)];
    // An Agent whose harness takes no images, whoever the reply is for.
    ws.store.update("b", "test/harness", &json!({}), |d| d.agent.harness = "plain-text".into()).unwrap();
    for said in [card("b", "Looks good", "r1", &images), ask(&ws, "b", "Go", "r1", &images), reply("b", "Hello", "r1", &images)] {
        refused(home::reply(&ws, project.clone(), said).await.unwrap_err(), "images_unsupported: Agent b can't receive images");
    }
    assert!(ws.store.receipt("b", "r1").unwrap().is_none() && !ws.data_dir.join("input-images/b").exists());
    // Never beside a form's answers.
    let mut form = ask(&ws, "c", "Answers", "r2", &images);
    (form.choice, form.form) = (None, Some(serde_json::from_value(json!({"formId":"prefs","answers":{}})).unwrap()));
    refused(home::reply(&ws, project.clone(), form).await.unwrap_err(), "form_images");
    // An image no longer saved on Home, or never: nothing is copied or sent.
    let gone = format!("{:064x}.png", 7);
    for said in [card("c", "Looks good", "r2", &[images[0].clone(), gone.clone()]), ask(&ws, "c", "Go", "r2", &[gone.clone()]),
        reply("c", "Hello", "r2", &[gone])] {
        refused(home::reply(&ws, project.clone(), said).await.unwrap_err(), "home_images: Saved image is missing");
    }
    assert!(ws.store.receipt("c", "r2").unwrap().is_none());
    // Without images, a reply to the same Agent b is not refused for them.
    let plain = home::reply(&ws, project.clone(), reply("b", "Hello", "r3", &[])).await.err().map(|error| error.to_string());
    assert!(plain.as_deref().is_none_or(|error| !error.starts_with("images_unsupported")), "{plain:?}");
}

/// The digest an ask's receipt keeps (T-9) is the same as before for a reply
/// without images, so a receipt written before them still matches its retry.
#[test]
fn a_reply_without_images_digests_as_before() {
    assert_eq!(home::reply_digest(Some("left"), "Go", None, &[]), "cdfbf01ca5b0be98d92aa3f8151510253aee6026fcdfe5e5d357a8f86c4adf4e");
    assert_eq!(home::reply_digest(None, "Go", None, &[]), "b431b391ae8fd92b994d54b6cffaf896a634d2a6d8fec82d44a2163a4611ab5f");
    let form: home::FormReply = serde_json::from_value(json!({"formId":"prefs","answers":{"theme":"dark"}})).unwrap();
    assert_eq!(home::reply_digest(None, "x", Some(&form), &[]), "e6a0679cb173349eec7a45b205af95452588bbfcfa2732fe8edf9d985883d32e");
    // With images, they come last.
    let images = vec!["one.png".to_owned()];
    let said = r#"["left","Go",{"images":["one.png"]}]"#;
    assert_eq!(home::reply_digest(Some("left"), "Go", None, &images), format!("{:x}", Sha256::digest(said.as_bytes())));
}

/// A replied ask shows the images its reply carried until its owner asks again.
#[tokio::test]
async fn an_answered_ask_shows_its_replys_images_until_its_owner_asks_again() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("q1", 0, vec![put("decide", "ask")])).await;
    let images = vec![attached(&ws, &project, 1), attached(&ws, &project, 2)];
    assert!(sections::mark_replied_form(&ws.store, &project, "decide", 1, "Left", None, &images).unwrap());
    let ask = |ws: &Workspace| section(&brief(ws, "a"), "decide")["ask"].clone();
    assert_eq!((ask(&ws)["state"].clone(), ask(&ws)["replyImages"].clone()), (json!("replied"), json!(images)));
    let kept: Option<String> = ws.store.db.read().unwrap().query_row(
        "SELECT reply_images FROM project_brief_sections WHERE project_id=?1 AND key='decide' AND live=1", [&project], |r| r.get(0)).unwrap();
    assert_eq!(kept.as_deref().map(|raw| serde_json::from_str::<Value>(raw).unwrap()), Some(json!(images)));
    // A reply without images clears any, as one without a form clears its answers.
    assert!(sections::mark_replied(&ws.store, &project, "decide", 1, "Right").unwrap());
    assert!(ask(&ws).get("replyImages").is_none(), "{}", ask(&ws));
    assert!(sections::mark_replied_form(&ws.store, &project, "decide", 1, "Left", None, &images).unwrap());
    // The owner's next version is a new question: open, with no reply's images.
    accept(&ws, "a", input("q2", version(&ws, &project), vec![put("decide", "ask")])).await;
    let next = ask(&ws);
    assert_eq!(next["state"], "open");
    assert!(next.get("replyImages").is_none(), "{next}");
    let cleared: Option<String> = ws.store.db.read().unwrap().query_row(
        "SELECT reply_images FROM project_brief_sections WHERE project_id=?1 AND key='decide' AND live=1", [&project], |r| r.get(0)).unwrap();
    assert_eq!(cleared, None);
}
