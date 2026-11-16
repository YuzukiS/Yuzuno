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

/// Its folders full: what can't be copied is left out, one line saying why
/// before the opening, which still names what goes (YN-173: before, the line
/// replaced it); with neither copied, a line for each, the newest first
/// (before, only the images' line was left).
#[tokio::test]
async fn an_executor_whose_folders_are_full_gets_what_fits_and_a_line_for_each_that_does_not() {
    let lab = lab();
    let (images, files) = (vec![image(&lab, 1)], vec![file(&lab, 1, "report.pdf")]);
    let n = lab.say_words(with(lab.words("按附件改", "m1"), &images, &files)).await;
    let made = lab.route("desk", n, "改版", "好。", vec![design("改版一", "先出布局"), design("改版二", "再出一版")]).await.unwrap();
    let key = |index: usize| made["routes"][index]["task"].as_str().unwrap().to_owned();
    let executor = |index: usize| made["routes"][index]["to"]["agentId"].as_str().unwrap().to_owned();
    // Each folder's 256 MiB taken by one sparse file.
    let fill = |dir: std::path::PathBuf| {
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::File::create(dir.join("filler")).unwrap().set_len(256 * 1024 * 1024).unwrap();
    };
    fill(images_dir(&lab, &executor(0)));
    fill(images_dir(&lab, &executor(1)));
    fill(files_dir(&lab, &executor(1)).join("filler"));
    for index in 0..2 {
        start(&lab, &executor(index));
        running(&lab.ws, &executor(index));
    }
    lab.ws.deliver_owed_attachments().await.unwrap();
    let images_full = "The user also attached 1 image to R-1 on Home, which could not be sent to you: The receiving Agent's saved images \
        reached the 256 MiB limit.";
    let sent = lab.receipt(&executor(0), &format!("route-{}", lab.route_id(n, 0))).expect("its file still goes");
    assert_eq!((sent.input.images.clone(), sent.files.clone()), (vec![], files.clone()));
    assert_eq!(sent.input.text, format!("{images_full}\n{}", head(&lab, "files", 1,
        &format!("the request's words are in the description of task {}, whose card you answer for.", key(0)))));
    let sent = lab.receipt(&executor(1), &format!("route-{}", lab.route_id(n, 1))).expect("the lines still go");
    assert!(sent.input.images.is_empty() && sent.files.is_empty());
    // Images are copied first (`send`), so their line comes second.
    assert_eq!(sent.input.text, format!("The user also attached 1 file to R-1 on Home, which could not be sent to you: \
        The receiving Agent's saved files reached the 256 MiB limit.\n{images_full}"));
    assert_eq!(shown(&lab, n, 1)["attachments"]["state"], "sent");
}

/// Refused for another reason (here a remote executor whose runtime is not
/// confirmed yet): tried again a minute later at the soonest, three times,
/// then the message goes without them, the line saying why; that refused
/// too, it failed. The user's words were never held up: they are in the
/// task's description.
#[tokio::test]
async fn a_hand_off_refused_three_times_goes_without_the_attachments_saying_why() {
    let lab = lab();
    let files = vec![file(&lab, 1, "report.pdf")];
    let n = lab.say_words(with(lab.words("看附件", "m1"), &[], &files)).await;
    let made = lab.route("desk", n, "附件", "好。", vec![design("看附件", "要设计")]).await.unwrap();
    let executor = made["routes"][0]["to"]["agentId"].as_str().unwrap().to_owned();
    lab.ws.store.update(&executor, "test/remote", &json!({}), |d| {
        d.agent.remote = Some(serde_json::from_value(json!({"machine": {
            "id":"offline", "name":"offline", "target":"-must-not-run-ssh", "codex":"codex", "defaultCwd":"/synthetic"}})).unwrap());
    }).unwrap();
    start(&lab, &executor);
    running(&lab.ws, &executor);
    let earlier = |lab: &Lab| lab.ws.store.db.write().unwrap().execute(
        "UPDATE project_routes SET attachments_note=json_set(attachments_note,'$.at','2026-01-01T00:00:00Z') WHERE attachments='owed'", []).unwrap();
    for tries in 1..=3 {
        lab.ws.deliver_owed_attachments().await.unwrap();
        let attachments = shown(&lab, n, 0)["attachments"].clone();
        assert_eq!((attachments["state"].clone(), attachments["tries"].clone()), (json!("owed"), json!(tries)), "{attachments}");
        assert!(attachments["error"].as_str().unwrap().contains("远程运行实例尚未确认"), "{attachments}");
        lab.ws.deliver_owed_attachments().await.unwrap();
        assert_eq!(shown(&lab, n, 0)["attachments"]["tries"], tries, "not again within a minute");
        earlier(&lab);
    }
    assert_eq!(lab.sent(&executor), 0);
    lab.ws.deliver_owed_attachments().await.unwrap();
    let sent = lab.receipt(&executor, &format!("route-{}", lab.route_id(n, 0))).expect("the line alone");
    assert!(sent.files.is_empty());
    assert_eq!(sent.input.text, "The user also attached 1 file to R-1 on Home, which could not be sent to you: 远程运行实例尚未确认，文件未发送；草稿保留.");
    let attachments = shown(&lab, n, 0)["attachments"].clone();
    assert_eq!((attachments["state"].clone(), attachments["unsent"].clone(), attachments["tries"].clone()), (json!("sent"), json!(true), json!(3)));
}

/// Owed to the card, not to an Agent: reassigned before they went, they go
/// to who answers for it now, with the words when that one never had the
/// front desk's mail; a card whose task ended first is owed nothing, and
/// nothing is copied.
#[tokio::test]
async fn owed_attachments_follow_the_card_and_end_with_its_task() {
    let lab = lab();
    let first = lab.say("设置页重新排版", "m1").await;
    let made = lab.route("desk", first, "排版", "好。", vec![design("排版", "要设计"), design("配色", "也要设计")]).await.unwrap();
    let key = |index: usize| made["routes"][index]["task"].as_str().unwrap().to_owned();
    let executor = made["routes"][0]["to"]["agentId"].as_str().unwrap().to_owned();
    let images = vec![image(&lab, 1)];
    let words = "按这张图";
    let second = lab.say_words(with(lab.words(words, "m2"), &images, &[])).await;
    lab.route("desk", second, "截图", "并进去。", vec![join(&key(0).to_lowercase(), "同一件事"), join(&key(1).to_lowercase(), "也相关")])
        .await.unwrap();
    // The first card goes to Lead, already running, before its executor started.
    let section = made["routes"][0]["sectionId"].clone();
    let (status, _) = reassign_on_page(&lab, &section, json!({"workspaceId":lab.workspace,"to":{"agentId":"lead"},"why":"给 Lead",
        "clientRequestId":"r1"}), false).await;
    assert_eq!(status, StatusCode::OK);
    // The second card's task ends before its executor started.
    lab.end(&key(1), "cancelled");
    lab.ws.deliver_owed_attachments().await.unwrap();
    let sent = lab.receipt("lead", &format!("route-{}", lab.route_id(second, 0))).expect("to who answers for the card now");
    assert_eq!(sent.input.images, images);
    assert!(sent.input.text.starts_with(&format!("Request R-2 from the user to the project Code (Workspace {}, Project {}), routed by the front \
        desk Desk to task {}", lab.workspace, lab.project, key(0))), "{}", sent.input.text);
    assert!(sent.input.text.ends_with(&format!("\n\n{words}")), "the words, which Lead never had: {}", sent.input.text);
    assert_eq!(lab.sent(&executor), 0);
    assert_eq!(shown(&lab, second, 1)["attachments"], json!({"state":"gone"}));
    let other = made["routes"][1]["to"]["agentId"].as_str().unwrap().to_owned();
    assert!(!images_dir(&lab, &other).exists(), "nothing copied for an ended card");
}

/// Without attachments nothing changes: no route owes anything, the task's
/// description and the queued mail are what they always were, and the step
/// sends nothing.
#[tokio::test]
async fn a_request_without_attachments_owes_nothing_and_reads_as_before() {
    let lab = lab();
    let n = lab.say("设置页重新排版", "m1").await;
    let made = lab.route("desk", n, "排版", "好。", vec![design("排版", "要设计")]).await.unwrap();
    let (key, executor) = (made["routes"][0]["task"].as_str().unwrap().to_owned(), made["routes"][0]["to"]["agentId"].as_str().unwrap().to_owned());
    let head = "Request R-1 from the user to the project Code, routed to this task's card by the front desk Desk. The user's words, exactly as written:";
    assert_eq!(lab.task(&key)["description"], format!("{head}\n\n设置页重新排版{WHY_PREFIX}要设计"));
    let second = lab.say("文案也改", "m2").await;
    lab.route("desk", second, "文案", "并进去。", vec![join(&key.to_lowercase(), "同一张")]).await.unwrap();
    let mail: Vec<_> = lab.mail(&executor).into_iter().filter(|m| m["dispatchId"].is_null()).collect();
    assert!(mail[0]["body"].as_str().unwrap().ends_with("\n\n文案也改\n\nWhy, in the front desk's words (not the user's): 同一张"), "{mail:?}");
    assert_eq!(lab.count("SELECT COUNT(*) FROM project_routes WHERE attachments IS NOT NULL OR attachments_note IS NOT NULL"), 0);
    for (request, index) in [(n, 0), (second, 0)] {
        assert!(shown(&lab, request, index).get("attachments").is_none());
    }
    start(&lab, &executor);
    running(&lab.ws, &executor);
    lab.ws.deliver_owed_attachments().await.unwrap();
    assert_eq!(lab.sent(&executor), 0);
}

/// The opening of a hand-off whose words went elsewhere keeps naming what
/// still goes after each line saying what can't (YN-173), and a message with
/// the words is opened as before.
#[test]
fn a_hand_offs_opening_keeps_what_still_goes_after_each_line_saying_what_cant() {
    let ctx = Ctx { workspace: "w".into(), project: "p".into(), name: "Code".into(), front: "Desk".into(), request: kept_request("看"),
        todo: vec![], given: 0 };
    let opening = Opening::Attachments { task: "COD-1", words: Carrier::Description, first: false };
    let files = not_sent(1, 0, 1, "dsh can't receive files");
    assert_eq!(files, "The user also attached 1 file to R-1 on Home, which could not be sent to you: dsh can't receive files.");
    assert_eq!(opening_text(&ctx, opening, std::slice::from_ref(&files), 2, 0), format!("{files}\nThe images the user attached to R-1 of the \
        project Code on Home (Workspace w, Project p); the request's words are in the description of task COD-1, whose card you answer for."));
    let images = not_sent(1, 2, 0, "Saved image is missing; attach it again");
    assert_eq!(opening_text(&ctx, opening, &[images.clone(), files.clone()], 0, 0), format!("{images}\n{files}"));
    let first = Opening::Attachments { task: "COD-1", words: Carrier::Mail, first: true };
    assert!(opening_text(&ctx, first, &[], 1, 0).ends_with("reached you in the front desk's mail about task COD-1, whose card you answer for. \
        Your dispatch for task COD-1 is in your Workspace mailbox."));
    assert_eq!(opening_text(&ctx, Opening::Words("Head:"), &[images.clone()], 0, 0), format!("{images}\nHead:"));
    assert_eq!(not_sent(1, 2, 1, "it was refused"), "The user also attached 2 images and 1 file to R-1 on Home, which could not be sent to you: \
        it was refused.");
}
