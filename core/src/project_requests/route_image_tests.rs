//! YN-134 S2b: a request's images go where routing sends its words. A
//! hand-off carries them to who answers for the card; one that can't be
//! given them still gets the words, Core's head saying why (Dev Lead 2, seq
//! 13370). A follow-up goes to each Agent with its images, or to none.
use super::*;
use sha2::{Digest, Sha256};

/// An image the user attached on Home in the lab's Project, by its ID.
fn attached(lab: &Lab, n: u8) -> String {
    let bytes = format!("synthetic image {n}").into_bytes();
    let id = format!("{:x}.png", Sha256::digest(&bytes));
    let dir = crate::input_images::home_dir(&lab.ws.data_dir, &lab.project).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&id), &bytes).unwrap();
    std::fs::write(dir.join(format!("{id}.thumb.png")), b"synthetic thumbnail").unwrap();
    id
}

fn holds(lab: &Lab, agent: &str, images: &[String]) -> bool {
    images.iter().all(|id| crate::input_images::image_path(&lab.ws.data_dir, agent, id).unwrap().is_file())
}

fn with(words: Words, images: &[String]) -> Words {
    Words { images: images.to_vec(), ..words }
}

#[tokio::test]
async fn a_join_hands_the_requests_images_to_who_answers_for_the_card_or_says_why_not() {
    let lab = lab();
    let first = lab.say("导出要 CSV", "m1").await;
    let made = lab.route("desk", first, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调"), to_agent("导出文档", "member", "写文档")])
        .await.unwrap();
    let card = |index: usize| made["routes"][index]["task"].as_str().unwrap().to_lowercase();
    let images = vec![attached(&lab, 1), attached(&lab, 2)];
    let head = |n: i64, key: &str| format!("Request R-{n} from the user to the project Code (Workspace {}, Project {}), routed by the front desk Desk \
        to task {key}, whose card you answer for; the user's words travel as they are:", lab.workspace, lab.project);

    // Who answers for the card takes images: its own copies go with the words.
    let second = lab.say_words(with(lab.words("截图里这一块", "m2"), &images)).await;
    assert_eq!(lab.receipt("desk", "m2").unwrap().input.images, images, "the front desk had them with the request");
    let answer = lab.route("desk", second, "导出截图", "并进去。", vec![join(&card(0), "同一件事")]).await.unwrap();
    assert_eq!(answer["routes"][0]["state"], "done", "{answer}");
    let client = format!("route-{}", lab.route_id(second, 0));
    let sent = lab.receipt("lead", &client).expect("handed to the card's responsible Agent");
    assert_eq!((sent.input.images.clone(), sent.input.text.clone()), (images.clone(), format!("{}\n\n截图里这一块", head(2, &made["routes"][0]["task"].as_str().unwrap()))));
    assert!(holds(&lab, "lead", &images));
    // Routed again: nothing is sent or copied twice.
    lab.route("desk", second, "导出截图", "并进去。", vec![join(&card(0), "同一件事")]).await.unwrap();
    assert_eq!(lab.sent("lead"), 1);

    // One that takes no images gets the words, and the head says why.
    lab.ws.store.update("member", "test/harness", &json!({}), |d| d.agent.harness = "plain-text".into()).unwrap();
    let third = lab.say_words(with(lab.words("文档也要截图", "m3"), &images)).await;
    let answer = lab.route("desk", third, "文档截图", "并进去。", vec![join(&card(1), "同一件事")]).await.unwrap();
    assert_eq!(answer["routes"][0]["state"], "done", "the hand-off never fails for its images: {answer}");
    let sent = lab.receipt("member", &format!("route-{}", lab.route_id(third, 0))).expect("the words still go");
    assert!(sent.input.images.is_empty());
    assert_eq!(sent.input.text, format!("The user also attached 2 images to R-3 on Home, which could not be sent to you: \
        Member can't receive images.\n{}\n\n文档也要截图", head(3, &made["routes"][1]["task"].as_str().unwrap())));
    assert!(!lab.ws.data_dir.join("input-images/member").exists(), "nothing copied");

    // Images no longer saved on Home: the words go, and the head says so.
    let gone = attached(&lab, 3);
    let fourth = lab.say_words(with(lab.words("再看这张", "m4"), std::slice::from_ref(&gone))).await;
    std::fs::remove_file(crate::input_images::home_dir(&lab.ws.data_dir, &lab.project).unwrap().join(&gone)).unwrap();
    let answer = lab.route("desk", fourth, "再看一张", "并进去。", vec![join(&card(0), "同一件事")]).await.unwrap();
    assert_eq!(answer["routes"][0]["state"], "done", "{answer}");
    let sent = lab.receipt("lead", &format!("route-{}", lab.route_id(fourth, 0))).unwrap();
    assert!(sent.input.images.is_empty());
    assert!(sent.input.text.starts_with("The user also attached 1 image to R-4 on Home, which could not be sent to you: Saved image is missing.\n"),
        "{}", sent.input.text);
}

/// A new card for an Agent already here (Dev Lead 2, seq 13386): the words
/// are in its task's description, and the images go to it as a message from
/// Home of one line; one that takes no images gets the line saying why.
/// A new executor reads only the description, which says how many there are.
#[tokio::test]
async fn a_new_card_for_an_agent_here_sends_it_the_images_beside_the_description() {
    let lab = lab();
    let images = vec![attached(&lab, 1), attached(&lab, 2)];
    let n = lab.say_words(with(lab.words("按截图改设置页", "m1"), &images)).await;
    lab.ws.store.update("member", "test/harness", &json!({}), |d| d.agent.harness = "plain-text".into()).unwrap();
    let made = lab.route("desk", n, "设置页", "好。", vec![to_agent("设置页代码", "lead", "开发协调"), to_agent("设置页文档", "member", "写文档"),
        design("设置页设计", "先出布局")]).await.unwrap();
    let states: Vec<_> = made["routes"].as_array().unwrap().iter().map(|r| r["state"].clone()).collect();
    assert_eq!(states, [json!("done"), json!("done"), json!("done")], "{made}");
    let key = |index: usize| made["routes"][index]["task"].as_str().unwrap().to_owned();
    let line = "The user also attached 2 images to R-1 on Home; a task description can't carry them.";
    for index in 0..3 {
        let description = lab.task(&key(index))["description"].as_str().unwrap().to_owned();
        assert!(description.contains(&format!("按截图改设置页

{line}

Why")), "{description}");
    }
    let sent = lab.receipt("lead", &format!("route-{}", lab.route_id(n, 0))).expect("the images, as a message from Home");
    assert_eq!(sent.input.images, images);
    assert_eq!(sent.input.text, format!("The images the user attached to R-1 of the project Code on Home (Workspace {}, Project {}); the request's words are in the description of task {}, whose card you answer for.", lab.workspace, lab.project, key(0)));
    assert!(holds(&lab, "lead", &images));
    let sent = lab.receipt("member", &format!("route-{}", lab.route_id(n, 1))).expect("the line saying why");
    assert!(sent.input.images.is_empty());
    assert_eq!(sent.input.text, "The user also attached 2 images to R-1 on Home, which could not be sent to you: Member can't receive images.");
    // Routed again: nothing more is sent.
    lab.route("desk", n, "设置页", "好。", vec![to_agent("设置页代码", "lead", "开发协调"), to_agent("设置页文档", "member", "写文档"),
        design("设置页设计", "先出布局")]).await.unwrap();
    assert_eq!((lab.sent("lead"), lab.sent("member")), (1, 1));
}

#[tokio::test]
async fn a_follow_up_with_images_goes_to_each_agent_answering_for_the_cards_or_to_none() {
    let lab = lab();
    let n = lab.say("导出要 CSV", "m1").await;
    lab.route("desk", n, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调"), to_agent("导出文档", "member", "写文档")]).await.unwrap();
    let images = vec![attached(&lab, 1)];
    let after = follow_up(&lab.ws, &lab.project, n, with(lab.words("看这张", "f1"), &images)).await.unwrap();
    let to: Vec<_> = after["reply"]["deliveredTo"].as_array().unwrap().iter().map(|d| d["agentId"].clone()).collect();
    assert_eq!(to, [json!("lead"), json!("member")]);
    for agent in ["lead", "member"] {
        assert_eq!(lab.receipt(agent, "f1").unwrap().input.images, images, "{agent}");
        assert!(holds(&lab, agent, &images), "{agent} has its own copy");
    }
    // One of them takes no images: none is sent any of it, and nothing is kept.
    lab.ws.store.update("member", "test/harness", &json!({}), |d| d.agent.harness = "plain-text".into()).unwrap();
    let error = follow_up(&lab.ws, &lab.project, n, with(lab.words("再看这张", "f2"), &images)).await.unwrap_err();
    assert!(error.to_string().starts_with("images_unsupported: Member answers for this request"), "{error}");
    assert!(lab.receipt("lead", "f2").is_none() && lab.receipt("member", "f2").is_none());
    assert_eq!(lab.request(n)["replies"].as_array().unwrap().len(), 1);
}

/// Where the words go in a task description or a mail, neither of which can
/// carry images, they say the images are there; without images, as before.
#[test]
fn a_task_description_and_a_mail_say_the_images_they_cant_carry() {
    let ctx = |text: &str, images: usize| Ctx {
        workspace: "w".into(), project: "p".into(), name: "Code".into(), front: "Desk".into(),
        request: Request { n: 3, images: (0..images).map(|n| format!("{n:064x}.png")).collect(), ..kept_request(text) }, todo: vec![], given: 0,
    };
    let (text, whole) = description(&ctx("看图", 2), "要设计");
    assert!(whole);
    assert_eq!(text, format!("{}\n\n看图\n\nThe user also attached 2 images to R-3 on Home; a task description can't carry them.{WHY_PREFIX}要设计",
        description_head(&ctx("看图", 2))));
    assert_eq!(description(&ctx("看图", 0), "要设计").0, format!("{}\n\n看图{WHY_PREFIX}要设计", description_head(&ctx("看图", 0))));
    let mail = queued_hand_off(&ctx("看图", 1), "要设计", "COD-1").unwrap();
    assert!(mail.contains("\n\n看图\n\nThe user also attached 1 image to R-3 on Home; a mail can't carry them.\n\nWhy"), "{mail}");
    assert!(!queued_hand_off(&ctx("看图", 0), "要设计", "COD-1").unwrap().contains("attached"));
    // words_fit counts the line.
    let line = images_left(&ctx("", 1), "a task description").len();
    let room = MAX_DESCRIPTION - WHY_ROOM - description_head(&ctx("", 1)).len() - 2 - line;
    assert!(words_fit(&ctx(&"a".repeat(room), 1)));
    assert!(!words_fit(&ctx(&"a".repeat(room + 1), 1)));
    assert!(words_fit(&ctx(&"a".repeat(room + 1), 0)), "without images, the room it always had");
}
