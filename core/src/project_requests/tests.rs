//! YN-86 S3a-1: a Project's front desk, the user's requests to it and their
//! follow-ups. The lab's Agents run no harness: a message Core admits gets a
//! receipt (written once send_message_from admitted it), whatever the
//! harness then does with it, so a receipt is what "sent" means here.
use super::{front_desk::FrontDesk, *};
use crate::model::{AgentDetail, MAX_MESSAGE_TEXT};
use axum::{body::Body, http::{Request as HttpRequest, StatusCode}};
use std::collections::BTreeMap;
use tower::ServiceExt;

fn agent(id: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work","model":"test","color":"sage",
        "threadId":format!("session-{id}"),"status":"working","connectionState":"connected","createdAt":"","updatedAt":"",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[{"id":"t1","status":"inProgress","items":[]}],"pending":[],"artifacts":[]}))
    .unwrap()
}

/// A Workspace on disk next to the build (/tmp is memory here) with one
/// Project, "Code", and its members a, b and c, all of them its leads.
fn lab() -> (tempfile::TempDir, Arc<Workspace>, String) {
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    let project = ws.store.create_project("Code", BTreeMap::new()).unwrap().id;
    for id in ["a", "b", "c"] {
        ws.store.insert(&agent(id)).unwrap();
        ws.store.set_agent_project(id, Some(&project)).unwrap();
    }
    set_leads(&ws, &project, &["a", "b", "c"]);
    (dir, ws, project)
}

fn set_leads(ws: &Workspace, project: &str, ids: &[&str]) {
    let version = crate::agent_roles::get(&ws.store, project).unwrap().version;
    crate::agent_roles::save(&ws.store, project, version, ids.iter().map(|id| id.to_string()).collect()).unwrap();
}

fn desk(ws: &Workspace, project: &str) -> FrontDesk {
    front_desk::get(&ws.store, project).unwrap()
}

/// The user's choice of front desk, saved against the version it has now.
fn choose(ws: &Workspace, project: &str, agent: Option<&str>) -> Result<FrontDesk> {
    front_desk::save(&ws.store, project, desk(ws, project).version, agent.map(str::to_owned))
}

fn close(ws: &Workspace, id: &str) {
    ws.store.update(id, "test/closed", &json!({}), |d| d.agent.closed_at = Some(crate::model::now())).unwrap();
}

fn words(ws: &Workspace, text: &str, id: &str) -> Words {
    Words { workspace_id: ws.store.workspace_id().unwrap(), text: text.into(), text_blocks: None, client_message_id: id.into() }
}

fn receipt(ws: &Workspace, agent: &str, id: &str) -> Option<MessageReceipt> {
    ws.store.receipt(agent, id).unwrap()
}

fn requests(ws: &Workspace, project: &str) -> Vec<Value> {
    page(&ws.store.db.read().unwrap(), project, None, Some(50)).unwrap()["requests"].as_array().unwrap().clone()
}

/// Refused before anything was kept or sent, with this code.
fn refused(error: anyhow::Error, code: &str) {
    assert!(error.is::<MessageNotSubmitted>(), "nothing was sent: {error}");
    assert!(error.to_string().starts_with(code), "{error}");
}

/// `MAX_REPLY` bytes: Chinese characters, then what is left of the limit.
fn longest() -> String {
    let words = "长".repeat(MAX_REPLY / 3) + &"a".repeat(MAX_REPLY % 3);
    assert_eq!(words.len(), MAX_REPLY);
    words
}

fn utf16(text: &str, start: usize, end: usize) -> String {
    String::from_utf16(&text.encode_utf16().collect::<Vec<_>>()[start..end]).unwrap()
}

// §4.1: the front desk is one of the Project's leads, chosen by the user and
// checked against the version the page read. A Project with one lead has it
// unsaved; with several and none chosen it has none. Only an open lead of
// this Project is taken.
#[test]
fn the_front_desk_is_a_lead_the_user_chooses_or_the_only_lead() {
    let (_dir, ws, project) = lab();
    assert_eq!(desk(&ws, &project), FrontDesk { version: 0, agent_id: None, effective_agent_id: None }, "three leads, none chosen");
    assert_eq!(choose(&ws, &project, Some("b")).unwrap(),
        FrontDesk { version: 1, agent_id: Some("b".into()), effective_agent_id: Some("b".into()) });
    let stale = front_desk::save(&ws.store, &project, 0, Some("c".into())).unwrap_err();
    assert!(stale.to_string().starts_with("version_conflict"), "{stale}");
    // Not an Agent outside the Project, a member that is not a lead, or a closed lead.
    ws.store.insert(&agent("x")).unwrap();
    for (id, why) in [("x", "not a member"), ("nobody", "no such Agent")] {
        let error = choose(&ws, &project, Some(id)).unwrap_err();
        assert!(error.to_string().starts_with("invalid_front_desk"), "{why}: {error}");
    }
    set_leads(&ws, &project, &["a", "b"]);
    assert!(choose(&ws, &project, Some("c")).unwrap_err().to_string().starts_with("invalid_front_desk"), "c is a member, no longer a lead");
    close(&ws, "a");
    assert!(choose(&ws, &project, Some("a")).unwrap_err().to_string().starts_with("invalid_front_desk"), "a closed lead");
    assert_eq!(desk(&ws, &project).agent_id.as_deref(), Some("b"), "refused saves change nothing");
    // Cleared by the user: with two leads, none.
    assert_eq!(choose(&ws, &project, None).unwrap().effective_agent_id, None);
    set_leads(&ws, &project, &["c"]);
    assert_eq!(desk(&ws, &project).effective_agent_id.as_deref(), Some("c"), "the only lead, unsaved");
    assert_eq!(desk(&ws, &project).agent_id, None);
}

// §4.1, agent_roles.rs: a front desk that stops leading the Project is
// cleared and the version moves on, whether the user's save of the leads
// left it out or it moved to another Project; a deleted Agent is cleared too.
#[test]
fn the_front_desk_is_cleared_when_it_stops_leading_the_project() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    set_leads(&ws, &project, &["a", "b"]);
    assert_eq!(desk(&ws, &project).agent_id.as_deref(), Some("b"), "still a lead");
    set_leads(&ws, &project, &["a"]);
    assert_eq!(desk(&ws, &project), FrontDesk { version: 2, agent_id: None, effective_agent_id: Some("a".into()) },
        "b left the leads: cleared, and the only lead takes requests");
    // Moved to another Project.
    set_leads(&ws, &project, &["a", "c"]);
    choose(&ws, &project, Some("c")).unwrap();
    let other = ws.store.create_project("Other", BTreeMap::new()).unwrap().id;
    ws.store.set_agent_project("c", Some(&other)).unwrap();
    assert_eq!(desk(&ws, &project), FrontDesk { version: 4, agent_id: None, effective_agent_id: Some("a".into()) });
    // Deleted.
    ws.store.set_agent_project("c", Some(&project)).unwrap();
    set_leads(&ws, &project, &["a", "c"]);
    choose(&ws, &project, Some("c")).unwrap();
    ws.store.db.write().unwrap().execute("DELETE FROM agents WHERE id='c'", []).unwrap();
    let stored: Option<String> = ws.store.db.read().unwrap()
        .query_row("SELECT agent_id FROM project_front_desk WHERE project_id=?1", [&project], |r| r.get(0)).unwrap();
    assert_eq!(stored, None);
    assert_eq!(desk(&ws, &project).effective_agent_id.as_deref(), Some("a"));
}

// §4.2: a request is kept and sent byte for byte: the message is Core's
// head, a blank line and the user's words as they wrote them (spaces and
// line breaks at either end included), and its pasted blocks are kept as
// sent and move past the head in the message, over the same text.
#[tokio::test]
async fn a_request_reaches_the_front_desk_as_the_user_wrote_it() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    let workspace = ws.store.workspace_id().unwrap();
    let text = "  看一下设置页 😀\n\nPASTE-ONE\r\nline two\n  ";
    let start = text.encode_utf16().count() - "PASTE-ONE\r\nline two\n  ".encode_utf16().count();
    let blocks = vec![TextBlock { id: "p1".into(), start, end: start + "PASTE-ONE\r\nline two".encode_utf16().count() }];
    let said = Words { text_blocks: Some(blocks.clone()), ..words(&ws, text, "m1") };
    let answer = submit(&ws, &project, said).await.unwrap();
    let request = &answer["request"];
    assert_eq!((request["n"].clone(), request["text"].clone()), (json!(1), json!(text)), "kept as written");
    assert_eq!(request["textBlocks"], serde_json::to_value(&blocks).unwrap(), "blocks kept as sent");
    assert_eq!((request["frontAgentId"].clone(), request["messageId"].clone(), request["title"].clone()), (json!("b"), json!("m1"), Value::Null));
    let sent = receipt(&ws, "b", "m1").expect("sent to the front desk");
    let head = request_head(&workspace, "Code", &project, 1);
    assert_eq!(sent.input.text, format!("{head}\n\n{text}"));
    assert!(sent.input.text.as_bytes().ends_with(text.as_bytes()));
    let moved = sent.input.text_blocks.clone().unwrap();
    assert_eq!(moved[0].start - blocks[0].start, head.encode_utf16().count() + 2);
    assert_eq!(utf16(&sent.input.text, moved[0].start, moved[0].end), utf16(text, blocks[0].start, blocks[0].end), "over the same text");
    assert_eq!(utf16(text, blocks[0].start, blocks[0].end), "PASTE-ONE\r\nline two");
    assert_eq!(sent.origin, Some(json!({"kind":"project_request","projectId":project,"requestId":request["id"],"request":1,"workspaceId":workspace})));
    assert_eq!(answer["receipt"]["input"]["clientMessageId"], "m1");
    // The front desk's conversation shows it as the user's, from Home.
    let mut turns = vec![json!({"id":"t1","items":[{"id":"i1","type":"userMessage","clientId":"m1","content":[{"type":"text","text":sent.input.text}]}]})];
    crate::input_origin::annotate(&ws.store.db.read().unwrap(), "b", &mut turns).unwrap();
    assert_eq!(turns[0]["items"][0]["_yuzunoInput"], "home");
    // Read back as kept, with the receipt's state.
    let listed = &requests(&ws, &project)[0];
    assert_eq!((listed["text"].clone(), listed["textBlocks"].clone()), (json!(text), serde_json::to_value(&blocks).unwrap()));
    assert_eq!(listed["delivery"], json!(sent.status));
    // Blocks that do not fall on the words' characters: refused, nothing kept.
    let bad = Words { text_blocks: Some(vec![TextBlock { id: "p".into(), start: 0, end: text.encode_utf16().count() + 1 }]), ..words(&ws, text, "m2") };
    refused(submit(&ws, &project, bad).await.unwrap_err(), "Invalid pasted text boundaries");
    assert_eq!(requests(&ws, &project).len(), 1);
}

// §4.2, the limit Home replies have (MAX_REPLY): words of exactly that many
// bytes are sent; one byte more is refused as reply_too_long, saying so in
// bytes, and nothing is kept or sent. A blank message, too.
#[tokio::test]
async fn a_request_or_follow_up_over_the_limit_is_refused_and_one_at_it_is_sent() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    submit(&ws, &project, words(&ws, &longest(), "most")).await.unwrap();
    assert!(receipt(&ws, "b", "most").is_some(), "the longest request is sent");
    let error = submit(&ws, &project, words(&ws, &(longest() + "a"), "over")).await.unwrap_err();
    refused(error, "reply_too_long: this message is 92001 bytes; a message to a project is at most 92000 bytes in UTF-8");
    refused(submit(&ws, &project, words(&ws, " \n\t", "blank")).await.unwrap_err(), "empty_message");
    assert!(receipt(&ws, "b", "over").is_none() && receipt(&ws, "b", "blank").is_none());
    assert_eq!(requests(&ws, &project).len(), 1);
    // A follow-up has the same limit.
    follow_up(&ws, &project, 1, words(&ws, &longest(), "f-most")).await.unwrap();
    assert!(receipt(&ws, "b", "f-most").is_some());
    refused(follow_up(&ws, &project, 1, words(&ws, &(longest() + "a"), "f-over")).await.unwrap_err(), "reply_too_long");
    assert!(receipt(&ws, "b", "f-over").is_none());
    assert_eq!(requests(&ws, &project)[0]["replies"].as_array().unwrap().len(), 1);
}

// §4.2: Core's head fits in the room MAX_REPLY leaves of a message (home.rs,
// QUOTE_ROOM), at the longest a head has: a Project name of 100 bytes
// (projects.rs), Workspace and Project IDs longer than the UUIDs Core makes,
// and the largest number.
#[test]
fn the_longest_head_fits_beside_the_longest_words() {
    let (workspace, project_id, name) = ("w".repeat(64), "p".repeat(64), "😀".repeat(25));
    assert_eq!(name.len(), 100);
    let words = longest();
    for head in [request_head(&workspace, &name, &project_id, i64::MAX), follow_up_head(&workspace, &name, &project_id, i64::MAX)] {
        let sent = message("m", &head, &words, None, None);
        assert!(sent.text.len() - words.len() <= MAX_MESSAGE_TEXT - MAX_REPLY, "a head of {} bytes", sent.text.len() - words.len());
        assert!(sent.text.len() <= MAX_MESSAGE_TEXT);
    }
}

// §4.2: the same clientMessageId again is the same request: one record, one
// number, the receipt of its one message, even after the Project was renamed
// and the front desk changed. Other words under it are refused, and the next
// request takes the next number.
#[tokio::test]
async fn submitting_a_request_again_is_the_same_request() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    let first = submit(&ws, &project, words(&ws, "导出要 CSV", "m1")).await.unwrap();
    ws.store.update_project(&project, crate::projects::ProjectChange {
        name: Some("Renamed".into()), key: None, default_dirs: BTreeMap::new(), archived: None }).unwrap();
    choose(&ws, &project, Some("c")).unwrap();
    let again = submit(&ws, &project, words(&ws, "导出要 CSV", "m1")).await.unwrap();
    assert_eq!(again["request"], first["request"]);
    assert_eq!(again["receipt"], first["receipt"], "its first message's receipt");
    assert!(receipt(&ws, "c", "m1").is_none(), "not sent to the new front desk");
    let other = submit(&ws, &project, words(&ws, "something else", "m1")).await.unwrap_err();
    assert!(other.to_string().contains("already used for another message"), "{other}");
    assert_eq!(requests(&ws, &project).len(), 1);
    let next = submit(&ws, &project, words(&ws, "next", "m2")).await.unwrap();
    assert_eq!((next["request"]["n"].clone(), next["request"]["frontAgentId"].clone()), (json!(2), json!("c")));
    assert!(receipt(&ws, "c", "m2").unwrap().input.text.starts_with("Request R-2 from the user to the project Renamed"));
    // A follow-up again is the same follow-up.
    let reply = follow_up(&ws, &project, 1, words(&ws, "还要 JSON", "f1")).await.unwrap();
    assert_eq!(follow_up(&ws, &project, 1, words(&ws, "还要 JSON", "f1")).await.unwrap(), reply);
    assert!(follow_up(&ws, &project, 1, words(&ws, "还要 XML", "f1")).await.unwrap_err().to_string().contains("already used"));
    assert_eq!(requests(&ws, &project)[1]["replies"].as_array().unwrap().len(), 1);
}

// §4.4: a follow-up is kept as the user wrote it and, while its request is
// not routed (S3a-2 routes requests), goes to the front desk as it is now,
// which may not be the one the request went to. Its blocks move past the head.
#[tokio::test]
async fn a_follow_up_goes_to_the_front_desk_while_its_request_is_not_routed() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    let workspace = ws.store.workspace_id().unwrap();
    let request = submit(&ws, &project, words(&ws, "设置页重新排版", "m1")).await.unwrap()["request"].clone();
    let text = " 还有：文案改口语 \nPASTED";
    let blocks = vec![TextBlock { id: "p".into(), start: 11, end: 17 }];
    assert_eq!(utf16(text, 11, 17), "PASTED");
    let said = Words { text_blocks: Some(blocks.clone()), ..words(&ws, text, "f1") };
    let answer = follow_up(&ws, &project, 1, said).await.unwrap();
    assert_eq!((answer["reply"]["n"].clone(), answer["reply"]["text"].clone()), (json!(1), json!(text)));
    assert_eq!(answer["reply"]["deliveredTo"][0]["agentId"], "b");
    let sent = receipt(&ws, "b", "f1").unwrap();
    let head = follow_up_head(&workspace, "Code", &project, 1);
    assert!(head.starts_with("Follow-up to request R-1 from the user"));
    assert_eq!(sent.input.text, format!("{head}\n\n{text}"));
    let moved = &sent.input.text_blocks.as_ref().unwrap()[0];
    assert_eq!(utf16(&sent.input.text, moved.start, moved.end), "PASTED");
    assert_eq!(sent.origin, Some(json!({"kind":"project_request","projectId":project,"requestId":request["id"],"request":1,"reply":1,"workspaceId":workspace})));
    // The front desk changed: the next follow-up goes to the new one.
    choose(&ws, &project, Some("c")).unwrap();
    follow_up(&ws, &project, 1, words(&ws, "再补一句", "f2")).await.unwrap();
    assert!(receipt(&ws, "c", "f2").is_some() && receipt(&ws, "b", "f2").is_none());
    let replies = requests(&ws, &project)[0]["replies"].clone();
    assert_eq!(replies.as_array().unwrap().iter().map(|r| (r["n"].clone(), r["deliveredTo"][0]["agentId"].clone())).collect::<Vec<_>>(),
        [(json!(1), json!("b")), (json!(2), json!("c"))]);
    assert_eq!(replies[0]["textBlocks"], serde_json::to_value(&blocks).unwrap());
    // Not to a request the Project does not have.
    refused(follow_up(&ws, &project, 9, words(&ws, "?", "f3")).await.unwrap_err(), "request_not_found");
}

// §4.1, §4.2: refused before anything was sent, nothing is kept and no
// number taken: with several leads and no front desk chosen, a closed front
// desk, another Workspace's page or an archived Project.
#[tokio::test]
async fn a_request_refused_before_it_was_sent_is_not_kept() {
    let (_dir, ws, project) = lab();
    refused(submit(&ws, &project, words(&ws, "hello", "m1")).await.unwrap_err(), "front_desk_required");
    choose(&ws, &project, Some("b")).unwrap();
    close(&ws, "b");
    assert!(submit(&ws, &project, words(&ws, "hello", "m2")).await.unwrap_err().is::<MessageNotSubmitted>(), "a closed front desk");
    assert!(requests(&ws, &project).is_empty(), "nothing kept");
    let elsewhere = Words { workspace_id: "another".into(), ..words(&ws, "hello", "m3") };
    refused(submit(&ws, &project, elsewhere).await.unwrap_err(), "workspace_changed");
    choose(&ws, &project, Some("c")).unwrap();
    let sent = submit(&ws, &project, words(&ws, "hello", "m4")).await.unwrap();
    assert_eq!(sent["request"]["n"], 1, "no number was taken");
    // A follow-up refused the same way is not kept either.
    close(&ws, "c");
    assert!(follow_up(&ws, &project, 1, words(&ws, "more", "f1")).await.unwrap_err().is::<MessageNotSubmitted>());
    assert!(requests(&ws, &project)[0]["replies"].as_array().unwrap().is_empty());
    ws.store.update_project(&project, crate::projects::ProjectChange {
        name: None, key: None, default_dirs: BTreeMap::new(), archived: Some(true) }).unwrap();
    refused(submit(&ws, &project, words(&ws, "hello", "m5")).await.unwrap_err(), "project_archived");
    assert_eq!(requests(&ws, &project).len(), 1, "an archived Project's requests are still read");
}

// GET /requests: newest first, a page below `before`, at most 50.
#[tokio::test]
async fn requests_are_read_newest_first_a_page_at_a_time() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("a")).unwrap();
    for n in 1..=5 {
        submit(&ws, &project, words(&ws, &format!("request {n}"), &format!("m{n}"))).await.unwrap();
    }
    let db = ws.store.db.read().unwrap();
    let numbers = |answer: Value| (answer["requests"].as_array().unwrap().iter().map(|r| r["n"].as_i64().unwrap()).collect::<Vec<_>>(), answer["hasMore"].clone());
    assert_eq!(numbers(page(&db, &project, None, Some(2)).unwrap()), (vec![5, 4], json!(true)));
    assert_eq!(numbers(page(&db, &project, Some(4), Some(2)).unwrap()), (vec![3, 2], json!(true)));
    assert_eq!(numbers(page(&db, &project, Some(2), None).unwrap()), (vec![1], json!(false)));
    assert_eq!(numbers(page(&db, &project, None, Some(500)).unwrap()).0.len(), 5);
    assert!(page(&db, "no-such-project", None, None).is_err());
}

// The routes are the user's page's, on this computer and the phone: an
// Agent's credential is refused before anything is read or written.
#[tokio::test]
async fn the_routes_refuse_an_agent_credential() {
    let (_dir, ws, project) = lab();
    let app = router().with_state(ws.clone());
    let call = |method: &str, path: String, credential: bool, body: Value| {
        let mut request = HttpRequest::builder().method(method).uri(path).header("content-type", "application/json");
        if credential {
            request = request.header("authorization", "Bearer agent-token");
        }
        request.body(Body::from(body.to_string())).unwrap()
    };
    let read = app.clone().oneshot(call("GET", format!("/api/projects/{project}/front-desk"), false, Value::Null)).await.unwrap();
    assert_eq!(read.status(), StatusCode::OK);
    let put = json!({"expectedVersion":0,"agentId":"b"});
    for (method, path, body) in [
        ("GET", format!("/api/projects/{project}/front-desk"), Value::Null),
        ("PUT", format!("/api/projects/{project}/front-desk"), put.clone()),
        ("GET", format!("/api/projects/{project}/requests"), Value::Null),
        ("POST", format!("/api/projects/{project}/requests"), json!({"workspaceId":"w","text":"hi","clientMessageId":"m"})),
        ("POST", format!("/api/projects/{project}/requests/1/replies"), json!({"workspaceId":"w","text":"hi","clientMessageId":"m"})),
    ] {
        let answer = app.clone().oneshot(call(method, path.clone(), true, body)).await.unwrap();
        assert_eq!(answer.status(), StatusCode::FORBIDDEN, "{method} {path}");
    }
    assert_eq!(desk(&ws, &project).version, 0, "nothing saved");
    let saved = app.oneshot(call("PUT", format!("/api/projects/{project}/front-desk"), false, put)).await.unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(desk(&ws, &project).agent_id.as_deref(), Some("b"));
}

// Dev Lead 2 (seq 12075): a request refused before it was sent gives its
// number back, only inside the Project's lock, so no request arriving at the
// same time takes the same number. Here R-1, kept by a Core that stopped
// before sending it (to "a", closed since), is sent again while eight new
// requests and one sent twice arrive at once, on four threads. The refused
// one leaves; every other request has a number of its own, and the message
// its front desk got names that number; the one sent twice is one request.
// Then the number a refused request took is the next one's.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_number_given_back_is_never_taken_twice_at_once() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    ws.store.db.write().unwrap().execute(
        "INSERT INTO project_requests(id,project_id,n,text,created_at,front_agent_id,message_id)
         VALUES('kept',?1,1,'hello','then','a','crashed')", [&project]).unwrap();
    close(&ws, "a");
    let call = |text: &str, id: &str| {
        let (ws, project, said) = (ws.clone(), project.clone(), words(&ws, text, id));
        tokio::spawn(async move { submit(&ws, &project, said).await })
    };
    let again = call("hello", "crashed");
    let new: Vec<_> = (0..8).map(|i| call(&format!("request {i}"), &format!("m{i}"))).collect();
    let twice = [call("twice", "dup"), call("twice", "dup")];
    let refused = again.await.unwrap().unwrap_err();
    assert!(refused.is::<MessageNotSubmitted>(), "{refused}");
    let mut numbers = Vec::new();
    for (i, call) in new.into_iter().enumerate() {
        let request = call.await.unwrap().unwrap()["request"].clone();
        let n = request["n"].as_i64().unwrap();
        let sent = receipt(&ws, "b", &format!("m{i}")).unwrap();
        assert!(sent.input.text.starts_with(&format!("Request R-{n} from")), "{}", sent.input.text);
        numbers.push(n);
    }
    let [first, second] = twice;
    let (first, second) = (first.await.unwrap().unwrap(), second.await.unwrap().unwrap());
    assert_eq!(first["request"], second["request"], "one request");
    numbers.push(first["request"]["n"].as_i64().unwrap());
    let mut kept: Vec<i64> = requests(&ws, &project).iter().map(|r| r["n"].as_i64().unwrap()).collect();
    kept.sort();
    numbers.sort();
    assert_eq!(kept, numbers, "each request kept once, under its own number");
    assert!(kept.windows(2).all(|pair| pair[0] < pair[1]), "no number twice: {kept:?}");
    let ids: Vec<Value> = requests(&ws, &project).iter().map(|r| r["id"].clone()).collect();
    assert!(!ids.contains(&json!("kept")), "the refused request left");
    // In turn: the refused request's number is the next one's.
    let next = kept.last().unwrap() + 1;
    close(&ws, "b");
    assert!(submit(&ws, &project, words(&ws, "to a closed desk", "x")).await.unwrap_err().is::<MessageNotSubmitted>());
    choose(&ws, &project, Some("c")).unwrap();
    let taken = submit(&ws, &project, words(&ws, "to an open desk", "y")).await.unwrap();
    assert_eq!(taken["request"]["n"], next);
}

// A clientMessageId already used for another message to the same Agent (one
// typed in its conversation, or the request a follow-up belongs to) is not
// this message: refused, nothing kept, and the other message is never read
// as this one's delivery.
#[tokio::test]
async fn another_messages_client_id_is_not_taken_for_this_one() {
    let (_dir, ws, project) = lab();
    choose(&ws, &project, Some("b")).unwrap();
    let typed = MessageReceipt { binding: None, skills: vec![], origin: Some(json!({"kind":"client"})), status: "accepted".into(),
        turn_id: Some("t1".into()), error: None, input: MessageInput { client_message_id: "typed".into(), text: "hi".into(),
            text_blocks: None, images: vec![], expected_turn_id: None, question: None, clarification: None } };
    ws.store.update_meta("b", "message/requested", &json!({}), move |m| m.message_receipts.push(typed)).unwrap();
    refused(submit(&ws, &project, words(&ws, "hello", "typed")).await.unwrap_err(), "This clientMessageId was already used");
    assert!(requests(&ws, &project).is_empty(), "nothing kept");
    submit(&ws, &project, words(&ws, "hello", "m1")).await.unwrap();
    refused(follow_up(&ws, &project, 1, words(&ws, "more", "m1")).await.unwrap_err(), "This clientMessageId was already used");
    let request = &requests(&ws, &project)[0];
    assert!(request["replies"].as_array().unwrap().is_empty(), "nothing kept");
    assert_eq!(request["delivery"], json!(receipt(&ws, "b", "m1").unwrap().status), "the request's own message");
}
