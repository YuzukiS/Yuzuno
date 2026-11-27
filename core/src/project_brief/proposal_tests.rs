//! YN-237 ④: a lead's proposal of a new request, asked under the request it
//! was found in. Only a lead proposes, and only under a request of its
//! Project. The user's "new" makes Core open the request once the reply has
//! reached the lead, once however often it is sent, linked both ways and sent
//! to the front desk: a reply refused or failed opens nothing. "merge" and
//! "later" open nothing and reach the lead as any reply does, saying so.
use super::*;
use crate::project_requests::{page, submit, Words};

fn proposal(key: &str, under: i64, title: &str) -> Value {
    json!({"op":"put","key":key,"kind":"ask","title":"拆出一项新请求？","body":body("执行中发现：推进一个运行时，阶段 Job 被整体读了四遍。"),
        "ask":{"question":"要不要单独做？","reply":{"options":[{"id":"new","label":"新建请求并关联"},{"id":"merge","label":"并入此请求"},
            {"id":"later","label":"先记下"}],"freeText":true},
            "proposal":{"request":under,"title":title,"text":"每次访问只读一遍阶段 Job，按同一负载测前后。不影响原请求的验收。"}}})
}

fn answer(ws: &Workspace, key: &str, choice: &str, id: &str) -> home::ReplyInput {
    home::ReplyInput { key: Some(key.into()), agent_id: "a".into(), text: String::new(), client_message_id: id.into(), choice: Some(choice.into()),
        version: None, title: None, ask_version: Some(1), workspace_id: Some(ws.store.workspace_id().unwrap()), form: None, images: vec![],
        files: vec![], intent: home::ReplyIntent::Answer, note: None }
}

fn requests(ws: &Workspace, project: &str) -> Vec<Value> {
    page(&ws.store.db.read().unwrap(), project, None, Some(50)).unwrap()["requests"].as_array().unwrap().clone()
}

fn request(ws: &Workspace, project: &str, n: i64) -> Value {
    requests(ws, project).into_iter().find(|r| r["n"] == n).unwrap()
}

/// The text of the message Core sent to `agent` under client ID `id`.
fn said(ws: &Workspace, agent: &str, id: &str) -> String {
    ws.store.receipt(agent, id).unwrap().expect("sent").input.text
}

/// The lab's Agents run no harness, so a message to one mid-Turn is not delivered (its receipt says rejected): as a
/// harness would have, `agent` accepts the message under `id`, whose retry then finds it delivered.
fn accepted(ws: &Workspace, agent: &str, id: &str) {
    let wanted = id.to_owned();
    ws.store.update_receipt_picking(agent, "test/accepted", &json!({}), id, move |meta| {
        for receipt in meta.message_receipts.iter_mut().filter(|r| r.input.client_message_id == wanted) {
            receipt.status = "accepted".into();
            receipt.error = None;
        }
    }, |_| ()).unwrap();
    assert_eq!(ws.store.receipt(agent, id).unwrap().unwrap().status, "accepted");
}

#[tokio::test]
async fn a_leads_proposal_opens_a_request_only_on_new_once_linked_both_ways() {
    let (_dir, ws, project) = lab();
    // a alone leads: it is the front desk; b is a member, Ask-only.
    set_leads(&ws, &project, &["a"]);
    let workspace = ws.store.workspace_id().unwrap();
    submit(&ws, &project, Words { workspace_id: workspace.clone(), text: "选下一批运行改进".into(), text_blocks: None, client_message_id: "m1".into(),
        images: vec![], files: vec![] }).await.unwrap();

    // Only a lead proposes, and only under a request this Project has.
    let not_lead = reject(&ws, "b", input("p0", version(&ws, &project), vec![proposal("yn-1/split", 1, "阶段 Job 只读一遍")])).await;
    assert_eq!(codes(&not_lead), ["proposal_not_lead"]);
    let unknown = reject(&ws, "a", input("p1", version(&ws, &project), vec![proposal("yn-1/split", 9, "阶段 Job 只读一遍")])).await;
    assert_eq!(codes(&unknown), ["proposal_request_unknown"]);
    accept(&ws, "a", input("p2", version(&ws, &project), vec![proposal("yn-1/split", 1, "阶段 Job 只读一遍")])).await;
    let shown = section(&brief(&ws, "a"), "yn-1/split").clone();
    assert_eq!(shown["ask"]["proposal"]["request"], 1, "{shown}");
    let panel = &home::build(&ws.store).unwrap()["projects"][0];
    let on_home = panel["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == "yn-1/split").unwrap();
    assert_eq!(on_home["ask"]["proposal"]["title"], "阶段 Job 只读一遍", "Home shows what it proposes");
    assert_eq!(requests(&ws, &project).len(), 1, "asking opens nothing");

    // The user's "new", not delivered (the lab's Agent takes no message mid-Turn): the ask stays open and nothing is
    // opened yet. The lead's reply says what Core does as it arrives.
    let receipt = home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap();
    assert_eq!(receipt.status, "rejected", "{receipt:?}");
    assert_eq!(section(&brief(&ws, "a"), "yn-1/split")["ask"]["state"], "open");
    let identity = identity(&ws, &project, "yn-1/split");
    assert!(ws.store.receipt("a", &format!("proposal:{identity}:1")).unwrap().is_none(), "R-2 is not sent before the reply");
    assert_eq!(requests(&ws, &project).len(), 1, "a reply not delivered opens nothing");
    let to_lead = said(&ws, "a", "r1");
    assert!(to_lead.contains("as the Project's next request linked to R-1 both ways") && to_lead.contains("Resolve this ask only then")
        && !to_lead.contains("Core opened"), "never says it is open before it is: {to_lead}");
    assert_eq!(section(&brief(&ws, "a"), "yn-1/split")["ask"]["proposal"]["opened"], Value::Null);
    // Delivered, its retry opens R-2, linked both ways, marks the ask replied and sends R-2 to the front desk.
    accepted(&ws, "a", "r1");
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap();
    let opened = request(&ws, &project, 2);
    assert_eq!((opened["title"].clone(), opened["text"].clone(), opened["frontAgentId"].clone()),
        (json!("阶段 Job 只读一遍"), json!("每次访问只读一遍阶段 Job，按同一负载测前后。不影响原请求的验收。"), json!("a")));
    assert_eq!(opened["from"], json!({"n":1,"key":"yn-1/split","sectionId":identity,"version":1,"at":opened["createdAt"]}));
    assert_eq!(opened["proposals"], json!([]));
    assert!(opened["delivery"].is_string(), "sent to the front desk: {opened}");
    let under = request(&ws, &project, 1);
    assert_eq!(under["proposals"], json!([{"n":2,"key":"yn-1/split","sectionId":identity,"version":1,"at":opened["createdAt"]}]));
    assert_eq!(under["from"], Value::Null);
    let to_desk = said(&ws, "a", &format!("proposal:{identity}:1"));
    assert!(to_desk.starts_with("Request R-2 to the project Code") && to_desk.contains("on the proposal `yn-1/split` made under R-1")
        && to_desk.ends_with("每次访问只读一遍阶段 Job，按同一负载测前后。不影响原请求的验收。"), "{to_desk}");
    assert_eq!(section(&brief(&ws, "a"), "yn-1/split")["ask"]["state"], "replied");
    assert_eq!(section(&brief(&ws, "a"), "yn-1/split")["ask"]["proposal"]["opened"], 2, "its lead reads the number on its ask");

    // The same reply again, and another window's "new" to the same version: still R-2 alone.
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap();
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r2")).await.unwrap();
    assert_eq!(requests(&ws, &project).iter().map(|r| r["n"].as_i64().unwrap()).collect::<Vec<_>>(), [2, 1]);
    assert_eq!(request(&ws, &project, 1)["proposals"].as_array().unwrap().len(), 1);

    // "merge" and "later" open nothing; each tells the lead what the user chose.
    accept(&ws, "a", input("p3", version(&ws, &project), vec![proposal("yn-1/fold", 1, "顺手修首页")])).await;
    accept(&ws, "a", input("p4", version(&ws, &project), vec![proposal("yn-1/note", 1, "以后再看")])).await;
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/fold", "merge", "r3")).await.unwrap();
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/note", "later", "r4")).await.unwrap();
    assert_eq!(requests(&ws, &project).len(), 2, "nothing more opened");
    assert!(said(&ws, "a", "r3").contains("the user chose to fold it into R-1; Core opened nothing"));
    assert!(said(&ws, "a", "r4").contains("the user chose to note it for later; Core opened nothing"));
    assert_eq!(request(&ws, &project, 1)["proposals"].as_array().unwrap().len(), 1);
}

// A "new" Core cannot open (no front desk) sends no reply and keeps nothing, so the reply never says it was opened.
#[tokio::test]
async fn a_new_core_cannot_open_sends_nothing() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let workspace = ws.store.workspace_id().unwrap();
    submit(&ws, &project, Words { workspace_id: workspace, text: "选下一批运行改进".into(), text_blocks: None, client_message_id: "m1".into(),
        images: vec![], files: vec![] }).await.unwrap();
    accept(&ws, "a", input("p1", version(&ws, &project), vec![proposal("yn-1/split", 1, "阶段 Job 只读一遍")])).await;
    // Two leads and none chosen: no front desk.
    set_leads(&ws, &project, &["a", "c"]);
    let error = home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap_err();
    assert!(error.to_string().starts_with("front_desk_required"), "{error}");
    assert!(error.is::<crate::collaboration_credentials::MessageNotSubmitted>(), "{error}");
    assert!(ws.store.receipt("a", "r1").unwrap().is_none(), "the reply was not sent");
    assert_eq!(requests(&ws, &project).len(), 1);
    assert_eq!(section(&brief(&ws, "a"), "yn-1/split")["ask"]["state"], "open");
}

// A "new" whose reply is refused or fails opens nothing (review f0c688e4): the user may answer again, and "merge" then
// leaves no request behind, as the lead is told.
#[tokio::test]
async fn a_new_not_delivered_opens_nothing_and_the_user_may_choose_again() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let workspace = ws.store.workspace_id().unwrap();
    submit(&ws, &project, Words { workspace_id: workspace, text: "选下一批运行改进".into(), text_blocks: None, client_message_id: "m1".into(),
        images: vec![], files: vec![] }).await.unwrap();
    accept(&ws, "a", input("p1", version(&ws, &project), vec![proposal("yn-1/split", 1, "阶段 Job 只读一遍")])).await;
    // A reply under a client ID already used for another message fails.
    let error = home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "m1")).await.unwrap_err();
    assert!(error.to_string().contains("already used for another message"), "{error}");
    assert_eq!(requests(&ws, &project).len(), 1, "a failed reply opens nothing");
    // Refused (the Agent mid-Turn), the reply opens nothing either.
    let receipt = home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap();
    assert_eq!(receipt.status, "rejected", "{receipt:?}");
    assert_eq!(requests(&ws, &project).len(), 1, "a refused reply opens nothing");
    assert_eq!(request(&ws, &project, 1)["proposals"], json!([]));
    // The user then folds it into R-1: delivered, nothing opened, and the lead is told so truly.
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "merge", "r2")).await.unwrap();
    accepted(&ws, "a", "r2");
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "merge", "r2")).await.unwrap();
    assert_eq!(section(&brief(&ws, "a"), "yn-1/split")["ask"]["state"], "replied");
    assert!(said(&ws, "a", "r2").contains("the user chose to fold it into R-1; Core opened nothing"));
    assert_eq!(requests(&ws, &project).len(), 1, "nothing opened");
    assert_eq!(request(&ws, &project, 1)["proposals"], json!([]));
}

/// Storage refuses to keep a proposal's request, as a full disk or a locked database would.
fn refuse_proposals(ws: &Workspace) {
    ws.store.db.write().unwrap().execute_batch(
        "CREATE TRIGGER test_refuse_proposals BEFORE INSERT ON project_requests WHEN NEW.message_id LIKE 'proposal:%'
         BEGIN SELECT RAISE(ABORT, 'storage refuses this write'); END;").unwrap();
}

fn accept_proposals(ws: &Workspace) {
    ws.store.db.write().unwrap().execute_batch("DROP TRIGGER test_refuse_proposals").unwrap();
}

fn on_home(ws: &Workspace, key: &str) -> Value {
    let panel = &home::build(&ws.store).unwrap()["projects"][0];
    panel["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap().clone()
}

// The reply delivered but the request not written (the lead's comment 12863 on YN-237): the reply errors without
// saying nothing was sent, so Home keeps it to send again; the ask stays open and shows no number, and the lead's
// words never said it was open. Sent again once storage takes writes, it opens the request, once.
#[tokio::test]
async fn a_new_delivered_but_not_kept_stays_open_and_opens_once_when_sent_again() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let workspace = ws.store.workspace_id().unwrap();
    submit(&ws, &project, Words { workspace_id: workspace, text: "选下一批运行改进".into(), text_blocks: None, client_message_id: "m1".into(),
        images: vec![], files: vec![] }).await.unwrap();
    accept(&ws, "a", input("p1", version(&ws, &project), vec![proposal("yn-1/split", 1, "阶段 Job 只读一遍")])).await;
    let receipt = home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap();
    assert_eq!(receipt.status, "rejected", "{receipt:?}");
    // The lead takes the reply, and storage refuses the request's write.
    accepted(&ws, "a", "r1");
    refuse_proposals(&ws);
    let error = home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap_err();
    assert!(error.to_string().starts_with("proposal_not_opened: your reply reached its lead"), "{error}");
    assert!(error.to_string().contains("storage refuses this write"), "{error}");
    assert!(!error.is::<crate::collaboration_credentials::MessageNotSubmitted>(), "it was sent: Home keeps it to send again");
    assert_eq!(ws.store.receipt("a", "r1").unwrap().unwrap().status, "accepted");
    assert!(!said(&ws, "a", "r1").contains("Core opened"), "the lead was never told it is open");
    assert_eq!(requests(&ws, &project).len(), 1, "nothing opened");
    let identity = identity(&ws, &project, "yn-1/split");
    assert!(ws.store.receipt("a", &format!("proposal:{identity}:1")).unwrap().is_none(), "nothing sent to the front desk");
    for shown in [section(&brief(&ws, "a"), "yn-1/split").clone(), on_home(&ws, "yn-1/split")] {
        assert_eq!(shown["ask"]["state"], "open", "not marked replied: Home still asks the user: {shown}");
        assert_eq!(shown["ask"]["proposal"]["opened"], Value::Null, "{shown}");
    }

    // Storage takes writes again: the reply sent again opens R-2, linked both ways, marks the ask and sends R-2.
    accept_proposals(&ws);
    let receipt = home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap();
    assert_eq!(receipt.status, "accepted");
    let opened = request(&ws, &project, 2);
    assert_eq!(opened["from"]["n"], 1);
    assert_eq!(request(&ws, &project, 1)["proposals"].as_array().unwrap().len(), 1);
    assert!(opened["delivery"].is_string(), "sent to the front desk: {opened}");
    for shown in [section(&brief(&ws, "a"), "yn-1/split").clone(), on_home(&ws, "yn-1/split")] {
        assert_eq!((shown["ask"]["state"].clone(), shown["ask"]["proposal"]["opened"].clone()), (json!("replied"), json!(2)), "{shown}");
    }
    // Again, and from another window: still R-2 alone.
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap();
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r2")).await.unwrap();
    assert_eq!(requests(&ws, &project).iter().map(|r| r["n"].as_i64().unwrap()).collect::<Vec<_>>(), [2, 1]);
}

// Sent again after its lead resolved the ask regardless: what the user chose still opens, as the reply's receipt keeps it.
#[tokio::test]
async fn a_new_sent_again_opens_its_request_even_after_the_ask_was_resolved() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let workspace = ws.store.workspace_id().unwrap();
    submit(&ws, &project, Words { workspace_id: workspace, text: "选下一批运行改进".into(), text_blocks: None, client_message_id: "m1".into(),
        images: vec![], files: vec![] }).await.unwrap();
    accept(&ws, "a", input("p1", version(&ws, &project), vec![proposal("yn-1/split", 1, "阶段 Job 只读一遍")])).await;
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap();
    accepted(&ws, "a", "r1");
    refuse_proposals(&ws);
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap_err();
    accept(&ws, "a", input("p2", version(&ws, &project), vec![json!({"op":"resolve","key":"yn-1/split"})])).await;
    accept_proposals(&ws);
    assert_eq!(section(&brief(&ws, "a"), "yn-1/split"), &Value::Null, "resolved: no longer live");
    home::reply(&ws, project.clone(), answer(&ws, "yn-1/split", "new", "r1")).await.unwrap();
    let opened = request(&ws, &project, 2);
    assert_eq!((opened["from"]["n"].clone(), opened["title"].clone()), (json!(1), json!("阶段 Job 只读一遍")));
    assert_eq!(requests(&ws, &project).len(), 2);
}
