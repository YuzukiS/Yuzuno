//! YN-134 S2b: a request and a follow-up carry the images the user attached
//! on Home to each Agent they go to, or nothing is kept or sent.
use super::*;
use sha2::{Digest, Sha256};

/// An image the user attached on Home in `project`, by its ID: content
/// addressed, with its thumbnail, as the Project's image route keeps one.
pub(super) fn attached(ws: &Workspace, project: &str, n: u8) -> String {
    let bytes = format!("synthetic image {n}").into_bytes();
    let id = format!("{:x}.png", Sha256::digest(&bytes));
    let dir = crate::input_images::home_dir(&ws.data_dir, project).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(&id), &bytes).unwrap();
    std::fs::write(dir.join(format!("{id}.thumb.png")), b"synthetic thumbnail").unwrap();
    id
}

/// Whether `agent` has each of `images` as its own.
pub(super) fn holds(ws: &Workspace, agent: &str, images: &[String]) -> bool {
    images.iter().all(|id| crate::input_images::image_path(&ws.data_dir, agent, id).unwrap().is_file())
}

fn with(words: Words, images: &[String]) -> Words {
    Words { images: images.to_vec(), ..words }
}

fn listed(ws: &Workspace, project: &str) -> Value {
    page(&ws.store.db.read().unwrap(), project, None, None).unwrap()["requests"].clone()
}

fn refused(error: anyhow::Error, code: &str) {
    assert!(error.to_string().starts_with(code), "{error}");
    assert!(error.is::<MessageNotSubmitted>(), "nothing was sent: {error}");
}

#[tokio::test]
async fn a_request_and_its_follow_up_take_their_images_to_the_front_desk() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    let images = vec![attached(&ws, &project, 1), attached(&ws, &project, 2)];
    let answer = submit(&ws, &project, with(words(&ws, "看这两张图", "m1"), &images)).await.unwrap();
    assert_eq!(answer["request"]["images"], json!(images));
    assert_eq!(receipt(&ws, "b", "m1").expect("sent to the front desk").input.images, images);
    assert!(holds(&ws, "b", &images), "copied to the front desk, under the same IDs");
    assert!(!ws.data_dir.join("input-images/a").exists() && !ws.data_dir.join("input-images/c").exists());
    // Listed with the request; one without any lists none.
    submit(&ws, &project, words(&ws, "没有图", "m2")).await.unwrap();
    let requests = listed(&ws, &project);
    assert_eq!((requests[0]["n"].clone(), requests[0]["images"].clone()), (json!(2), json!([])));
    assert_eq!((requests[1]["n"].clone(), requests[1]["images"].clone()), (json!(1), json!(images)));
    // The same message again is the same request; with other images it is another message.
    assert_eq!(submit(&ws, &project, with(words(&ws, "看这两张图", "m1"), &images)).await.unwrap()["request"]["n"], 1);
    for other in [&images[..1], &[][..]] {
        let error = submit(&ws, &project, with(words(&ws, "看这两张图", "m1"), other)).await.unwrap_err();
        assert!(error.to_string().contains("already used for another message"), "{error}");
    }
    // A follow-up carries its own.
    let reply = follow_up(&ws, &project, 1, with(words(&ws, "还有这张", "f1"), &images[1..])).await.unwrap();
    assert_eq!(reply["reply"]["images"], json!(&images[1..]));
    assert_eq!(receipt(&ws, "b", "f1").unwrap().input.images, images[1..].to_vec());
    assert_eq!(listed(&ws, &project)[1]["replies"][0]["images"], json!(&images[1..]));
    let error = follow_up(&ws, &project, 1, words(&ws, "还有这张", "f1")).await.unwrap_err();
    assert!(error.to_string().contains("already used for another message"), "{error}");
    // The Project keeps its own copies for the next message.
    assert!(images.iter().all(|id| crate::input_images::home_dir(&ws.data_dir, &project).unwrap().join(id).is_file()));
}

#[tokio::test]
async fn a_message_whose_images_cant_go_keeps_nothing_and_sends_nothing() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    assert_eq!(submit(&ws, &project, words(&ws, "先说一句", "m0")).await.unwrap()["request"]["n"], 1);
    let images = vec![attached(&ws, &project, 1)];
    // A front desk that takes no images: refused, nothing kept, no number taken.
    ws.store.update("b", "test/harness", &json!({}), |d| d.agent.harness = "plain-text".into()).unwrap();
    refused(submit(&ws, &project, with(words(&ws, "看图", "m1"), &images)).await.unwrap_err(),
        "images_unsupported: Agent b answers for this request and can't receive images");
    refused(follow_up(&ws, &project, 1, with(words(&ws, "补一张", "f1"), &images)).await.unwrap_err(), "images_unsupported: Agent b");
    assert!(receipt(&ws, "b", "m1").is_none() && receipt(&ws, "b", "f1").is_none());
    assert!(!ws.data_dir.join("input-images/b").exists(), "nothing copied");
    let requests = listed(&ws, &project);
    assert_eq!((requests.as_array().unwrap().len(), requests[0]["replies"].clone()), (1, json!([])));
    // An image not saved in this Project's images written on Home: refused before anything.
    let elsewhere = ws.store.create_project("Elsewhere", Default::default()).unwrap().id;
    let other = attached(&ws, &elsewhere, 2);
    for gone in [format!("{:064x}.png", 7), other] {
        refused(submit(&ws, &project, with(words(&ws, "看图", "m2"), std::slice::from_ref(&gone))).await.unwrap_err(),
            "home_images: Saved image is missing");
        refused(follow_up(&ws, &project, 1, with(words(&ws, "补一张", "f2"), &[gone])).await.unwrap_err(), "home_images");
    }
    assert_eq!(listed(&ws, &project).as_array().unwrap().len(), 1);
    // Nine at once: refused on the count.
    let nine: Vec<String> = (0..9).map(|n| format!("{n:064x}.png")).collect();
    refused(submit(&ws, &project, with(words(&ws, "看图", "m3"), &nine)).await.unwrap_err(), "home_images: Attach at most 8 images");
}

/// Rows written before images were kept read as having none, and the
/// columns are added once on an older database.
#[tokio::test]
async fn an_older_database_gets_the_images_columns_and_its_rows_read_with_none() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    submit(&ws, &project, words(&ws, "旧的需求", "m1")).await.unwrap();
    follow_up(&ws, &project, 1, words(&ws, "旧的跟进", "f1")).await.unwrap();
    let columns = |db: &Connection, table: &str| -> i64 {
        db.query_row(&format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name='images'"), [], |r| r.get(0)).unwrap()
    };
    {
        let db = ws.store.db.write().unwrap();
        db.execute_batch("ALTER TABLE project_requests DROP COLUMN images; ALTER TABLE project_request_replies DROP COLUMN images;").unwrap();
        assert_eq!((columns(&db, "project_requests"), columns(&db, "project_request_replies")), (0, 0), "as an older Core left it");
        migrate(&db).unwrap();
        migrate(&db).unwrap();
        assert_eq!((columns(&db, "project_requests"), columns(&db, "project_request_replies")), (1, 1));
    }
    let requests = listed(&ws, &project);
    assert_eq!((requests[0]["images"].clone(), requests[0]["replies"][0]["images"].clone()), (json!([]), json!([])));
}
