//! YN-145 F6: a request's files go where routing sends its words, and a
//! hand-off a file can't go with still goes on (files are YN-145's, as
//! images are YN-134's).
use super::*;
use sha2::{Digest, Sha256};

/// A file the user attached on Home in the lab's Project, by its reference.
fn attached(lab: &Lab, n: u8, name: &str) -> crate::input_files::FileRef {
    let bytes = format!("synthetic file {n}").into_bytes();
    let id = format!("{:x}", Sha256::digest(&bytes));
    let dir = crate::input_files::home_dir(&lab.ws.data_dir, &lab.project).unwrap();
    std::fs::create_dir_all(dir.join(&id)).unwrap();
    std::fs::write(dir.join(&id).join(name), &bytes).unwrap();
    crate::input_files::FileRef { id, name: name.into(), bytes: bytes.len() as u64 }
}

fn holds(lab: &Lab, agent: &str, files: &[crate::input_files::FileRef]) -> bool {
    let dir = crate::input_files::agent_dir(&lab.ws.data_dir, agent).unwrap();
    files.iter().all(|file| dir.join(&file.id).join(&file.name).is_file())
}

fn with(words: Words, files: &[crate::input_files::FileRef]) -> Words {
    Words { files: files.to_vec(), ..words }
}

/// A card route naming its own agent, whose words fit the task description,
/// still hands a files-only request to it (YN-145 P2 from review 7e0a59be).
#[tokio::test]
async fn a_card_for_an_agent_here_sends_it_a_files_only_request_beside_the_description() {
    let lab = lab();
    let files = vec![attached(&lab, 1, "report.pdf")];
    let n = lab.say_words(with(lab.words("按附件改设置页", "m1"), &files)).await;
    let made = lab.route("desk", n, "设置页", "好。", vec![to_agent("设置页代码", "lead", "开发协调")]).await.unwrap();
    assert_eq!(made["routes"][0]["state"], "done", "{made}");
    let key = made["routes"][0]["task"].as_str().unwrap().to_owned();
    let sent = lab.receipt("lead", &format!("route-{}", lab.route_id(n, 0))).expect("the files, as a message from Home");
    assert_eq!(sent.files, files);
    assert!(holds(&lab, "lead", &files), "copied to the Agent that answers for the card");
    assert!(sent.input.text.starts_with("The files the user attached to R-1"), "{}", sent.input.text);
    assert!(sent.input.text.contains(&key), "{}", sent.input.text);
    // Routed again: nothing is sent or copied twice.
    lab.route("desk", n, "设置页", "好。", vec![to_agent("设置页代码", "lead", "开发协调")]).await.unwrap();
    assert_eq!(lab.sent("lead"), 1);
}

/// A route retried after its files were dropped reuses the first message
/// rather than failing as "already used" (review 7e0a59be).
#[tokio::test]
async fn a_route_retried_after_its_files_were_dropped_reuses_its_first_message() {
    let lab = lab();
    let files = vec![attached(&lab, 1, "report.pdf")];
    let client = "route-retry";
    let origin = json!({"kind":ORIGIN,"projectId":lab.project,"requestId":"r","request":1,"route":"x","workspaceId":lab.workspace});
    let compose = |turn: Option<String>| message(client, "Request R-1 from Home, the user's words:", "改一下", None, &[], turn);
    // The first attempt went without its files (a fallback).
    send(&lab.ws, &lab.project, "lead", client, &[], true, origin.clone(), compose).await.unwrap();
    // The retry carries them again: the same route message stands, without an error.
    let again = send(&lab.ws, &lab.project, "lead", client, &files, true, origin, compose).await.unwrap();
    assert!(again.status == "rejected" || again.status == "accepted" || again.status == "queued", "{:?}", again.status);
    assert!(lab.ws.store.receipt("lead", client).unwrap().is_some());
}

/// Files for a remote Agent are refused as files, before anything is copied,
/// so a route's hand-off can go on without them (review 7e0a59be).
#[tokio::test]
async fn a_remote_agents_files_are_refused_before_copying_so_a_hand_off_goes_on() {
    let lab = lab();
    let files = vec![attached(&lab, 1, "report.pdf")];
    lab.ws.store.update("lead", "test/remote", &json!({}), |d| {
        d.agent.remote = Some(serde_json::from_value(json!({"machine": {
            "id":"offline", "name":"offline", "target":"-must-not-run-ssh", "codex":"codex", "defaultCwd":"/tmp"}})).unwrap());
    }).unwrap();
    let error = crate::project_requests::adopt_files(&lab.ws, &lab.project, "lead", &files).await.unwrap_err();
    let why = crate::project_requests::files_refused(&error).expect("a files refusal, not a plain one");
    assert!(why.contains("another machine"), "{why}");
    assert!(!ws_files(&lab, "lead").exists(), "nothing was copied");
}

fn ws_files(lab: &Lab, agent: &str) -> std::path::PathBuf {
    crate::input_files::agent_dir(&lab.ws.data_dir, agent).unwrap()
}
