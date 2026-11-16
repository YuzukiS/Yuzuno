//! YN-173: a request's images and files routed to a card whose executor had
//! not started (a new executor, or one still waiting for its slot) are owed
//! to the card, and go once the Agent answering for it has started, as a
//! hand-off to a running Agent goes: copied to it then, every check and
//! quota as YN-134 and YN-145 have them, the user's words never held up.
//! The lab's executors never start by themselves: a test takes their slot
//! and connects them as a slot pass would (`start`), and gives them their
//! first Turn as their dispatch's mail would (`running`).
use super::*;
use crate::input_files::FileRef;
use sha2::{Digest, Sha256};

fn image(lab: &Lab, n: u8) -> String {
    let bytes = format!("synthetic owed image {n}").into_bytes();
    let id = format!("{:x}.png", Sha256::digest(&bytes));
    let dir = crate::input_images::home_dir(&lab.ws.data_dir, &lab.project).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&id), &bytes).unwrap();
    std::fs::write(dir.join(format!("{id}.thumb.png")), b"synthetic thumbnail").unwrap();
    id
}

fn file(lab: &Lab, n: u8, name: &str) -> FileRef {
    let bytes = format!("synthetic owed file {n}").into_bytes();
    let id = format!("{:x}", Sha256::digest(&bytes));
    let dir = crate::input_files::home_dir(&lab.ws.data_dir, &lab.project).unwrap();
    std::fs::create_dir_all(dir.join(&id)).unwrap();
    std::fs::write(dir.join(&id).join(name), &bytes).unwrap();
    FileRef { id, name: name.into(), bytes: bytes.len() as u64 }
}

fn with(words: Words, images: &[String], files: &[FileRef]) -> Words {
    Words { images: images.to_vec(), files: files.to_vec(), ..words }
}

fn images_dir(lab: &Lab, agent: &str) -> std::path::PathBuf {
    lab.ws.data_dir.join("input-images").join(agent)
}

fn files_dir(lab: &Lab, agent: &str) -> std::path::PathBuf {
    crate::input_files::agent_dir(&lab.ws.data_dir, agent).unwrap()
}

/// Its slot taken and its runtime connected, as a slot pass leaves it: idle,
/// before any Turn.
fn start(lab: &Lab, agent: &str) {
    lab.ws.store.db.write().unwrap().execute("UPDATE executor_slots SET state='running' WHERE agent_id=?1", [agent]).unwrap();
    lab.ws.store.update(agent, "test/started", &json!({}), |d| {
        d.agent.connection_state = "connected".into();
        d.agent.status = "idle".into();
    }).unwrap();
}

/// A route of request `n` as the Project's page shows it.
fn shown(lab: &Lab, n: i64, index: usize) -> Value {
    lab.request(n)["routes"].as_array().unwrap().iter().find(|r| r["index"] == index as i64).cloned().unwrap()
}

fn head(lab: &Lab, what: &str, n: i64, words: &str) -> String {
    format!("The {what} the user attached to R-{n} of the project Code on Home (Workspace {}, Project {}); {words}", lab.workspace, lab.project)
}

/// A new executor's card: owed while it waits and before its first Turn,
/// then its own copies with one message from Home, image parts and file
/// paths; once only.
#[tokio::test]
async fn a_new_executor_gets_the_requests_images_and_files_once_it_has_started() {
    let lab = lab();
    let (images, files) = (vec![image(&lab, 1), image(&lab, 2)], vec![file(&lab, 1, "report.pdf")]);
    let n = lab.say_words(with(lab.words("按截图和附件改设置页", "m1"), &images, &files)).await;
    let made = lab.route("desk", n, "设置页", "好。", vec![design("设置页设计", "先出布局")]).await.unwrap();
    assert_eq!(made["routes"][0]["state"], "done", "{made}");
    let (key, executor) = (made["routes"][0]["task"].as_str().unwrap().to_owned(), made["routes"][0]["to"]["agentId"].as_str().unwrap().to_owned());
    // Waiting for its slot, then started but before its first Turn: nothing.
    lab.ws.deliver_owed_attachments().await.unwrap();
    start(&lab, &executor);
    lab.ws.deliver_owed_attachments().await.unwrap();
    assert_eq!(lab.sent(&executor), 0);
    assert!(!images_dir(&lab, &executor).exists() && !files_dir(&lab, &executor).exists(), "nothing copied before it goes");
    // Its first Turn: the message joins it, as a hand-off to a running Agent.
    running(&lab.ws, &executor);
    lab.ws.deliver_owed_attachments().await.unwrap();
    let sent = lab.receipt(&executor, &format!("route-{}", lab.route_id(n, 0))).expect("its images and files, as a message from Home");
    assert_eq!((sent.input.images.clone(), sent.files.clone(), sent.input.expected_turn_id.clone()), (images.clone(), files.clone(), Some("t1".into())));
    assert_eq!(sent.input.text, head(&lab, "images and files", 1, &format!("the request's words are in the description of task {key}, whose card \
        you answer for.")));
    assert_eq!(sent.origin.as_ref().unwrap()["kind"], ORIGIN);
    assert!(images.iter().all(|id| images_dir(&lab, &executor).join(id).is_file()), "its own copies of the images");
    let path = std::fs::canonicalize(files_dir(&lab, &executor).join(&files[0].id).join("report.pdf")).unwrap();
    assert_eq!(sent.file_paths, [path.display().to_string()], "the path it reads its file at");
    // What the route recorded and the task's description said before it started.
    assert_eq!(made["routes"][0]["attachments"], json!({"state":"owed"}));
    let description = lab.task(&key)["description"].as_str().unwrap().to_owned();
    assert!(description.contains("按截图和附件改设置页\n\nThe user also attached 2 images and 1 file to R-1 on Home; whoever answers for this \
        card gets them as a message from Home (an executor once it has started).\n\nWhy"), "{description}");
    assert_eq!(shown(&lab, n, 0)["attachments"], json!({"state":"sent","tries":0}));
    // Once: every later step sends nothing more.
    lab.ws.deliver_owed_attachments().await.unwrap();
    lab.route("desk", n, "设置页", "好。", vec![design("设置页设计", "先出布局")]).await.unwrap();
    assert_eq!(lab.sent(&executor), 1);
}

/// A join to a card whose executor waits for its slot: the words by the
/// front desk's mail, as before, saying the images and files follow; they
/// come as a message from Home once it has started.
#[tokio::test]
async fn a_queued_executor_gets_the_words_by_mail_and_the_attachments_once_it_has_started() {
    let lab = lab();
    let first = lab.say("设置页重新排版", "m1").await;
    let made = lab.route("desk", first, "设置页排版", "好。", vec![design("设置页排版", "要设计")]).await.unwrap();
    assert!(made["routes"][0].get("attachments").is_none(), "nothing owed without attachments: {made}");
    let (key, executor) = (made["routes"][0]["task"].as_str().unwrap().to_owned(), made["routes"][0]["to"]["agentId"].as_str().unwrap().to_owned());
    let (images, files) = (vec![image(&lab, 1)], vec![file(&lab, 1, "notes.txt")]);
    let second = lab.say_words(with(lab.words("文案也改", "m2"), &images, &files)).await;
    let joined = lab.route("desk", second, "文案", "并进设计卡。", vec![join(&key.to_lowercase(), "同一张设置页")]).await.unwrap();
    assert_eq!(joined["routes"][0]["state"], "done", "{joined}");
    start(&lab, &executor);
    running(&lab.ws, &executor);
    lab.ws.deliver_owed_attachments().await.unwrap();
    let sent = lab.receipt(&executor, &format!("route-{}", lab.route_id(second, 0))).expect("its attachments, as a message from Home");
    assert_eq!((sent.input.images.clone(), sent.files.clone()), (images, files));
    assert_eq!(sent.input.text, head(&lab, "images and files", 2, &format!("the request's words reached you in the front desk's mail about task \
        {key}, whose card you answer for.")));
    // What the route recorded and the mail said before it started.
    assert_eq!(joined["routes"][0]["attachments"], json!({"state":"owed"}), "{joined}");
    let mail: Vec<_> = lab.mail(&executor).into_iter().filter(|m| m["dispatchId"].is_null()).collect();
    assert!(mail[0]["body"].as_str().unwrap().contains("\n\n文案也改\n\nThe user also attached 1 image and 1 file to R-2 on Home; they come to you \
        as a message from Home once you have started.\n\nWhy"), "{mail:?}");
}
