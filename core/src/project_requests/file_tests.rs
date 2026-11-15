//! YN-145 F6: a request and a follow-up carry the files the user attached on
//! Home to each Agent they go to, or nothing is kept or sent.
use super::*;
use sha2::{Digest, Sha256};

/// A file the user attached on Home in `project`, by its reference: content
/// addressed, as the Project's file route keeps one.
pub(super) fn attached(ws: &Workspace, project: &str, n: u8, name: &str) -> crate::input_files::FileRef {
    let bytes = format!("synthetic file {n}").into_bytes();
    let id = format!("{:x}", Sha256::digest(&bytes));
    let dir = crate::input_files::home_dir(&ws.data_dir, project).unwrap();
    std::fs::create_dir_all(dir.join(&id)).unwrap();
    std::fs::write(dir.join(&id).join(name), &bytes).unwrap();
    crate::input_files::FileRef { id, name: name.into(), bytes: bytes.len() as u64 }
}

/// Whether `agent` has each of `files` as its own.
pub(super) fn holds(ws: &Workspace, agent: &str, files: &[crate::input_files::FileRef]) -> bool {
    let dir = crate::input_files::agent_dir(&ws.data_dir, agent).unwrap();
    files.iter().all(|file| dir.join(&file.id).join(&file.name).is_file())
}

fn with(words: Words, files: &[crate::input_files::FileRef]) -> Words {
    Words { files: files.to_vec(), ..words }
}

fn refused(error: anyhow::Error, code: &str) {
    assert!(error.to_string().starts_with(code), "{error}");
    assert!(error.is::<MessageNotSubmitted>(), "nothing was sent: {error}");
}

#[tokio::test]
async fn a_request_and_its_follow_up_take_their_files_to_the_front_desk() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    let files = vec![attached(&ws, &project, 1, "report.pdf"), attached(&ws, &project, 2, "notes.txt")];
    let answer = submit(&ws, &project, with(words(&ws, "看这两个文件", "m1"), &files)).await.unwrap();
    assert_eq!(answer["request"]["files"], json!(files));
    assert_eq!(receipt(&ws, "b", "m1").expect("sent to the front desk").files, files);
    assert!(holds(&ws, "b", &files), "copied to the front desk, each at its own path");
    assert!(!ws.data_dir.join("input-files/a").exists() && !ws.data_dir.join("input-files/c").exists());
    // Listed with the request; one without any lists none.
    submit(&ws, &project, words(&ws, "没有文件", "m2")).await.unwrap();
    let requests = page(&ws.store.db.read().unwrap(), &project, None, None).unwrap()["requests"].clone();
    assert_eq!((requests[0]["n"].clone(), requests[0]["files"].clone()), (json!(2), json!([])));
    assert_eq!((requests[1]["n"].clone(), requests[1]["files"].clone()), (json!(1), json!(files)));
    // The same message again is the same request; with other files it is another message.
    assert_eq!(submit(&ws, &project, with(words(&ws, "看这两个文件", "m1"), &files)).await.unwrap()["request"]["n"], 1);
    for other in [&files[..1], &[][..]] {
        let error = submit(&ws, &project, with(words(&ws, "看这两个文件", "m1"), other)).await.unwrap_err();
        assert!(error.to_string().contains("already used for another message"), "{error}");
    }
    // A follow-up carries its own.
    let reply = follow_up(&ws, &project, 1, with(words(&ws, "还有这个", "f1"), &files[1..])).await.unwrap();
    assert_eq!(reply["reply"]["files"], json!(&files[1..]));
    assert_eq!(receipt(&ws, "b", "f1").unwrap().files, files[1..].to_vec());
    let listed = page(&ws.store.db.read().unwrap(), &project, None, None).unwrap()["requests"].clone();
    assert_eq!(listed[1]["replies"][0]["files"], json!(&files[1..]));
    let error = follow_up(&ws, &project, 1, words(&ws, "还有这个", "f1")).await.unwrap_err();
    assert!(error.to_string().contains("already used for another message"), "{error}");
    // The Project keeps its own staging copies for the next message.
    let staging = crate::input_files::home_dir(&ws.data_dir, &project).unwrap();
    assert!(files.iter().all(|file| staging.join(&file.id).join(&file.name).is_file()));
}

#[tokio::test]
async fn a_message_whose_files_cant_go_keeps_nothing_and_sends_nothing() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    submit(&ws, &project, words(&ws, "先说一句", "m0")).await.unwrap();
    let files = vec![attached(&ws, &project, 1, "report.pdf")];
    // A front desk that takes no files: refused, nothing kept, no number taken.
    ws.store.update("b", "test/harness", &json!({}), |d| d.agent.harness = "plain-text".into()).unwrap();
    refused(submit(&ws, &project, with(words(&ws, "看文件", "m1"), &files)).await.unwrap_err(),
        "files_unsupported: Agent b answers for this request and can't receive files");
    refused(follow_up(&ws, &project, 1, with(words(&ws, "补一个", "f1"), &files)).await.unwrap_err(), "files_unsupported: Agent b");
    assert!(receipt(&ws, "b", "m1").is_none() && receipt(&ws, "b", "f1").is_none());
    assert!(!ws.data_dir.join("input-files/b").exists(), "nothing copied");
    let listed = page(&ws.store.db.read().unwrap(), &project, None, None).unwrap()["requests"].clone();
    assert_eq!((listed.as_array().unwrap().len(), listed[0]["replies"].clone()), (1, json!([])));
    // A file not saved in this Project's files written on Home: refused before anything.
    let elsewhere = ws.store.create_project("Elsewhere", Default::default()).unwrap().id;
    let other = attached(&ws, &elsewhere, 2, "other.txt");
    for gone in [crate::input_files::FileRef { id: format!("{:064x}", 7), name: "gone.txt".into(), bytes: 4 }, other] {
        refused(submit(&ws, &project, with(words(&ws, "看文件", "m2"), std::slice::from_ref(&gone))).await.unwrap_err(),
            "home_files: Saved file is missing");
        refused(follow_up(&ws, &project, 1, with(words(&ws, "补一个", "f2"), &[gone])).await.unwrap_err(), "home_files");
    }
}
