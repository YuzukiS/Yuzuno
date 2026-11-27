//! R-31 #3: what the front desk owes the user, by number (pending.rs). The
//! list holds each request not routed or answered and each follow-up no note
//! names; only a note naming a follow-up clears it. It is read from the
//! records, so a new Workspace on the same data reads the same, and a new
//! front desk reads it as its own. Core tells the front desk of each item
//! once: at the end of one of its Turns, when it becomes the front desk, and
//! when a result comes on a routed task while follow-ups wait. Synthetic
//! records; every call through the tools' own entry (collaboration_call).
use super::*;
use crate::project_requests::pending;

async fn list(lab: &Lab, actor: &str, input: Value) -> Result<Value> {
    lab.ws.collaboration_call(Some(actor), pending::TOOL, input).await
}

/// The items a list names, as R-n or R-n #m.
fn labels(listed: &Value) -> Vec<String> {
    listed["items"].as_array().unwrap().iter()
        .map(|item| match item["followUp"].as_i64() {
            Some(m) => format!("{} #{m}", item["request"].as_str().unwrap()),
            None => item["request"].as_str().unwrap().to_owned(),
        })
        .collect()
}

async fn owed(lab: &Lab) -> Vec<String> {
    labels(&list(lab, "desk", json!({})).await.unwrap())
}

async fn follow(lab: &Lab, n: i64, text: &str, id: &str) {
    follow_up(&lab.ws, &lab.project, n, lab.words(text, id)).await.unwrap();
}

async fn answer_alone(lab: &Lab, actor: &str, n: i64, note: &str, reply_to: Value) -> Result<Value> {
    lab.ws.collaboration_call(Some(actor), TOOL, json!({"request":format!("R-{n}"),"note":note,"replyTo":reply_to})).await
}

/// Every message's receipt to `agent` says `status`.
fn receipts(lab: &Lab, agent: &str, status: &str) {
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE agent_receipts SET data=json_set(data,'$.status',?2) WHERE agent_id=?1", params![agent, status]).unwrap();
}

/// One of `agent`'s Turns ended, as Core journals it.
fn turn_ended(lab: &Lab, agent: &str) {
    lab.ws.store.db.write().unwrap()
        .execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'turn/completed',?2,?3)",
            params![agent, json!({"turn":{"id":uuid::Uuid::new_v4().to_string(),"status":"completed"}}).to_string(), crate::model::now()])
        .unwrap();
}

/// Core's mail to `agent` about what the front desk owes.
fn told(lab: &Lab, agent: &str) -> Vec<Value> {
    lab.mail(agent).into_iter().filter(|m| m["metadata"]["kind"] == "projectRequests").collect()
}

fn items(mail: &Value) -> Vec<(i64, Option<i64>)> {
    mail["metadata"]["items"].as_array().unwrap().iter()
        .map(|item| (item["request"].as_i64().unwrap(), item["followUp"].as_i64()))
        .collect()
}

/// The last mails of a kind went more than SPACING ago.
fn long_ago(lab: &Lab) {
    let at = (chrono::Utc::now() - chrono::Duration::minutes(11)).to_rfc3339();
    let db = lab.ws.store.db.write().unwrap();
    db.execute("UPDATE project_request_told SET at=?1", [&at]).unwrap();
    db.execute("UPDATE project_request_result_told SET at=?1", [&at]).unwrap();
}

// A request is owed until a route puts it on a card or answers it; a
// follow-up until a note names it. One note may name several, in any order,
// again and again; a note naming none, one naming another, a delivery, a
// card, a task's progress or result clear nothing.
#[tokio::test]
async fn the_list_holds_what_no_route_or_note_naming_it_has_answered() {
    let lab = lab();
    let n = lab.say("导出要 CSV", "m1").await;
    assert_eq!(owed(&lab).await, ["R-1"], "said, not routed");
    lab.route("desk", n, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调")]).await.unwrap();
    assert!(owed(&lab).await.is_empty(), "routed to a card");
    for (text, id) in [("还要 JSON", "f1"), ("再加 XML", "f2"), ("还有 YAML", "f3")] {
        follow(&lab, n, text, id).await;
    }
    assert_eq!(owed(&lab).await, ["R-1 #1", "R-1 #2", "R-1 #3"]);
    answer_alone(&lab, "desk", n, "XML 加上。", json!([2])).await.unwrap();
    assert_eq!(owed(&lab).await, ["R-1 #1", "R-1 #3"], "only #2 is named");
    // Nothing reports here that they reached the front desk: unsent, still owed.
    let listed = list(&lab, "desk", json!({})).await.unwrap();
    assert_eq!(listed["items"][0]["state"], "unsent");
    // Still being sent is said so, not that it reached no one.
    receipts(&lab, "desk", "sending");
    let listed = list(&lab, "desk", json!({})).await.unwrap();
    assert_eq!((listed["items"][0]["state"].clone(), listed["items"][0]["note"].clone()),
        (json!("sending"), json!("its message is still being sent: none was taken or queued yet")));
    receipts(&lab, "desk", "accepted");
    // A note naming none: it may answer them, so they show as later, still owed.
    lab.route("desk", n, "导出", "在做了。", vec![to_agent("导出代码", "lead", "开发协调")]).await.unwrap();
    let listed = list(&lab, "desk", json!({})).await.unwrap();
    assert_eq!(listed["items"].as_array().unwrap().iter().map(|i| i["state"].clone()).collect::<Vec<_>>(), [json!("later"), json!("later")]);
    assert_eq!(listed["items"][0]["reply"], "project_route {\"request\":\"R-1\",\"note\":\"<your reply>\",\"replyTo\":[1]}");
    // The card's task moves on and has a result: no reply.
    let task = lab.request(n)["cards"][0]["task"]["id"].as_str().unwrap().to_owned();
    lab.ws.collaboration_call(Some("lead"), "task_update", json!({"requestId":"p","taskId":task,"expectedVersion":lab.task(&task)["version"],
        "patch":{"progress":"JSON 和 YAML 在做"}})).await.unwrap();
    let held = lab.task(&task);
    lab.ws.collaboration_call(Some("lead"), "task_submit_result", json!({"requestId":"r","taskId":task,"expectedVersion":held["version"],
        "dispatchId":held["dispatch"]["id"],"summary":"JSON 做好了","status":"doing"})).await.unwrap();
    assert_eq!(owed(&lab).await, ["R-1 #1", "R-1 #3"], "a task's progress and result are no reply");
    // Out of order, in one note, then again: both answered, nothing lost.
    answer_alone(&lab, "desk", n, "JSON 和 YAML 都加。", json!([3, 1])).await.unwrap();
    answer_alone(&lab, "desk", n, "JSON 和 YAML 都加。", json!([1, 3])).await.unwrap();
    assert!(owed(&lab).await.is_empty());
    follow(&lab, n, "还要 TOML", "f4").await;
    answer_alone(&lab, "desk", n, "TOML 不做。", json!([2])).await.unwrap();
    assert_eq!(owed(&lab).await, ["R-1 #4"], "a note naming another follow-up answers none of this one");
    // An answer route handles a request, as its state says.
    let m = lab.say("现在几点发布？", "m2").await;
    assert_eq!(owed(&lab).await, ["R-1 #4", "R-2"]);
    lab.route("desk", m, "发布时间", "今晚。", vec![answer("一句话能答")]).await.unwrap();
    assert_eq!(owed(&lab).await, ["R-1 #4"]);
    // A route that fails keeps its request owed, though its note is written (routes.rs records it first).
    let failed = lab.say("并进设置页那张卡", "m3").await;
    let answer = lab.route("desk", failed, "设置页", "并进去。", vec![join("nothing-here", "同一张卡")]).await.unwrap();
    assert_eq!(answer["routes"][0]["state"], "failed", "{answer}");
    assert_eq!(lab.request(failed)["notes"][0]["note"], "并进去。");
    assert_eq!(owed(&lab).await, ["R-1 #4", "R-3"]);
    let listed = list(&lab, "desk", json!({})).await.unwrap();
    assert_eq!(listed["owed"], json!({"requests":1,"followUps":1}));
    assert_eq!(listed["youAreFrontDesk"], true);
}

// Only the Project's leads read it; a lead that is not the front desk is told
// who is. A request's words are read whole, in parts.
#[tokio::test]
async fn leads_read_it_and_an_item_whole_in_parts() {
    let lab = lab();
    let long = "长".repeat(30_000);
    let n = lab.say(&long, "m1").await;
    let error = list(&lab, "member", json!({})).await.unwrap_err().to_string();
    assert!(error.starts_with("not_lead:"), "{error}");
    let as_lead = list(&lab, "lead", json!({})).await.unwrap();
    assert_eq!((as_lead["youAreFrontDesk"].clone(), as_lead["frontDesk"]["agentId"].clone()), (json!(false), json!("desk")));
    assert!(as_lead["note"].as_str().unwrap().contains("Only the front desk replies"));
    let item = &as_lead["items"][0];
    assert_eq!((item["wordsChars"].as_i64(), item["words"].as_str().unwrap().chars().count()), (Some(30_000), 201), "a preview");
    let mut words = String::new();
    let mut offset = json!(0);
    loop {
        let part = list(&lab, "desk", json!({"request":format!("R-{n}"),"offset":offset})).await.unwrap();
        assert_eq!(part["owed"], true);
        words.push_str(part["words"].as_str().unwrap());
        assert!(part["words"].as_str().unwrap().len() <= 24_000);
        match part.get("nextOffset") {
            Some(next) => offset = next.clone(),
            None => break,
        }
    }
    assert_eq!(words, long, "read whole, in parts");
    let error = list(&lab, "desk", json!({"request":"R-9"})).await.unwrap_err().to_string();
    assert!(error.starts_with("request_not_found:"), "{error}");
    let error = list(&lab, "desk", json!({"request":format!("R-{n}"),"followUp":1})).await.unwrap_err().to_string();
    assert!(error.starts_with("follow_up_not_found:"), "{error}");
    let error = list(&lab, "desk", json!({"followUp":1})).await.unwrap_err().to_string();
    assert!(error.starts_with("invalid_input:"), "{error}");
}

// Read from the records alone: a Workspace opened again on the same data,
// with nothing kept in memory, reads the same list, and old follow-ups that
// went to an executor before R-45 are in it.
#[tokio::test]
async fn a_workspace_opened_again_reads_the_same_list() {
    let lab = lab();
    let n = lab.say("导出要 CSV", "m1").await;
    lab.route("desk", n, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调")]).await.unwrap();
    follow(&lab, n, "还要 JSON", "f1").await;
    follow(&lab, n, "再加 XML", "f2").await;
    // #1 went to someone else, as one did before R-45.
    lab.ws.store.db.write().unwrap().execute("UPDATE project_request_replies SET delivered_to='[\"member\"]' WHERE n=1", []).unwrap();
    lab.say("另一件事", "m2").await;
    let before = list(&lab, "desk", json!({})).await.unwrap();
    assert_eq!(owed(&lab).await, ["R-1 #1", "R-1 #2", "R-2"]);
    // The Workspace ends; another opens the same data, with nothing of the first in memory.
    let Lab { dir, ws, folder, .. } = lab;
    drop(ws);
    let again = Workspace::new(dir.path().join("data"), folder, "unused-harness".into()).unwrap();
    let after = again.collaboration_call(Some("desk"), pending::TOOL, json!({})).await.unwrap();
    assert_eq!(after, before);
    assert_eq!(after["items"][0]["to"][0]["agentId"], "member");
}

// When a Turn of the front desk ends: one mail of what it had (or never
// had) and left owed, each item once; nothing still on its way to it; at
// most one mail a SPACING; nothing for another Agent's Turn; and the Turn its
// own mail begins ends with nothing new, so it never wakes it again.
#[tokio::test]
async fn a_turn_end_tells_the_front_desk_once_of_what_it_left_owed() {
    let lab = lab();
    // Events that are no Turn's end, however many, ask nothing of the writer:
    // the saved position stays, the pass's own moves on in memory.
    lab.ws.remind_pending_replies().await.unwrap();
    let saved = || lab.count("SELECT CAST(value AS INTEGER) FROM workspace_meta WHERE key='projectRequests.pendingTurnSeq'");
    let before = saved();
    for _ in 0..3 {
        lab.ws.store.db.write().unwrap()
            .execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('desk','test/event','{}',?1)", [crate::model::now()]).unwrap();
    }
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(saved(), before, "nothing written");
    let n = lab.say("导出要 CSV", "m1").await;
    lab.route("desk", n, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调")]).await.unwrap();
    follow(&lab, n, "还要 JSON", "f1").await;
    receipts(&lab, "desk", "queued");
    turn_ended(&lab, "desk");
    lab.ws.remind_pending_replies().await.unwrap();
    assert!(told(&lab, "desk").is_empty(), "still on its way to it: its own Turn takes it");
    // Still being sent: said so in the list, and no reminder either.
    receipts(&lab, "desk", "sending");
    assert_eq!(list(&lab, "desk", json!({})).await.unwrap()["items"][0]["state"], "sending");
    turn_ended(&lab, "desk");
    lab.ws.remind_pending_replies().await.unwrap();
    assert!(told(&lab, "desk").is_empty(), "being sent to it: no reminder");
    receipts(&lab, "desk", "accepted");
    turn_ended(&lab, "lead");
    lab.ws.remind_pending_replies().await.unwrap();
    assert!(told(&lab, "desk").is_empty() && told(&lab, "lead").is_empty(), "another Agent's Turn tells no one");
    turn_ended(&lab, "desk");
    lab.ws.remind_pending_replies().await.unwrap();
    let mail = told(&lab, "desk");
    assert_eq!(mail.len(), 1);
    assert_eq!(items(&mail[0]), [(1, Some(1))]);
    assert_eq!((mail[0]["metadata"]["status"].clone(), mail[0]["metadata"]["why"].clone(), mail[0]["wake"].clone()),
        (json!("awaitingReply"), json!("turn"), json!("ring")));
    let body = mail[0]["body"].as_str().unwrap();
    assert!(body.contains("R-1 #1") && body.contains("还要 JSON") && body.contains("replyTo [m]") && body.contains("project_requests_pending"), "{body}");
    // The Turn the mail begins ends: nothing new, no mail.
    turn_ended(&lab, "desk");
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(told(&lab, "desk").len(), 1, "told once");
    // A new follow-up within SPACING waits; after it, only the new one is told.
    follow(&lab, n, "再加 XML", "f2").await;
    receipts(&lab, "desk", "accepted");
    turn_ended(&lab, "desk");
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(told(&lab, "desk").len(), 1, "at most one mail a SPACING");
    long_ago(&lab);
    turn_ended(&lab, "desk");
    lab.ws.remind_pending_replies().await.unwrap();
    let mail = told(&lab, "desk");
    assert_eq!(mail.len(), 2);
    assert_eq!(items(&mail[1]), [(1, Some(2))], "only what it was not told of");
    // Answered, nothing more, however many Turns end.
    answer_alone(&lab, "desk", n, "都加。", json!([1, 2])).await.unwrap();
    long_ago(&lab);
    for _ in 0..3 {
        turn_ended(&lab, "desk");
    }
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(told(&lab, "desk").len(), 2);
}

// A new front desk is told, at once, what went to someone else: to the
// front desk before it, or (before R-45) to an executor. Saving the leads
// again tells nothing new; what goes to it, its own Turn's end tells.
#[tokio::test]
async fn a_new_front_desk_is_told_what_went_to_someone_else() {
    let lab = lab();
    // The lab's own saves of the leads and front desk queued checks: owed nothing yet.
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(lab.count("SELECT COUNT(*) FROM project_request_desk_checks"), 0);
    let n = lab.say("导出要 CSV", "m1").await;
    lab.route("desk", n, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调")]).await.unwrap();
    follow(&lab, n, "还要 JSON", "f1").await;
    follow(&lab, n, "再加 XML", "f2").await;
    lab.ws.store.db.write().unwrap().execute("UPDATE project_request_replies SET delivered_to='[\"member\"]' WHERE n=1", []).unwrap();
    lab.ws.remind_pending_replies().await.unwrap();
    assert!(told(&lab, "desk").is_empty(), "no check queued: nothing read");
    let version = front_desk::get(&lab.ws.store, &lab.project).unwrap().version;
    front_desk::save(&lab.ws.store, &lab.project, version, Some("lead".into())).unwrap();
    lab.ws.remind_pending_replies().await.unwrap();
    let mail = told(&lab, "lead");
    assert_eq!(mail.len(), 1);
    assert_eq!(items(&mail[0]), [(1, Some(1)), (1, Some(2))], "both went to someone else");
    assert_eq!(mail[0]["metadata"]["why"], "desk");
    assert!(told(&lab, "desk").is_empty(), "the one before is told nothing");
    assert_eq!(lab.count("SELECT COUNT(*) FROM project_request_desk_checks"), 0, "the check is done");
    let version = crate::agent_roles::get(&lab.ws.store, &lab.project).unwrap().version;
    crate::agent_roles::save(&lab.ws.store, &lab.project, version, vec!["desk".into(), "lead".into()]).unwrap();
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(told(&lab, "lead").len(), 1, "nothing new");
    // Its own reply clears them; the one before cannot reply now.
    answer_alone(&lab, "lead", n, "都加。", json!([1, 2])).await.unwrap();
    assert!(owed(&lab).await.is_empty());
    let error = answer_alone(&lab, "desk", n, "都加。", json!([1])).await.unwrap_err().to_string();
    assert!(error.starts_with("not_front_desk:"), "{error}");
    // The lead leaves; the only lead left is the front desk, told nothing new (answered).
    let version = crate::agent_roles::get(&lab.ws.store, &lab.project).unwrap().version;
    crate::agent_roles::save(&lab.ws.store, &lab.project, version, vec!["desk".into()]).unwrap();
    lab.ws.remind_pending_replies().await.unwrap();
    assert!(told(&lab, "desk").is_empty());
}

// A result on a task a request was routed to, while that request's
// follow-ups wait: the front desk is sent back to it, once a SPACING for the
// request; not once they are answered.
#[tokio::test]
async fn a_result_sends_the_front_desk_back_to_the_request_whose_follow_ups_wait() {
    let lab = lab();
    let n = lab.say("导出要 CSV", "m1").await;
    lab.route("desk", n, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调")]).await.unwrap();
    let task = lab.request(n)["cards"][0]["task"]["id"].as_str().unwrap().to_owned();
    let result = |id: &str| {
        let (lab, task, id) = (&lab, task.clone(), id.to_owned());
        async move {
            let held = lab.task(&task);
            lab.ws.collaboration_call(Some("lead"), "task_submit_result", json!({"requestId":id,"taskId":task,
                "expectedVersion":held["version"],"dispatchId":held["dispatch"]["id"],"summary":"进展","status":"doing"})).await.unwrap();
        }
    };
    result("r0").await;
    lab.ws.remind_pending_replies().await.unwrap();
    assert!(told(&lab, "desk").is_empty(), "no follow-up waits");
    follow(&lab, n, "JSON 好了吗？", "f1").await;
    receipts(&lab, "desk", "queued");
    result("r1").await;
    lab.ws.remind_pending_replies().await.unwrap();
    assert!(told(&lab, "desk").is_empty(), "the follow-up is still on its way to it");
    receipts(&lab, "desk", "sending");
    result("r1b").await;
    lab.ws.remind_pending_replies().await.unwrap();
    assert!(told(&lab, "desk").is_empty(), "being sent to it: no reminder");
    receipts(&lab, "desk", "accepted");
    result("r2").await;
    lab.ws.remind_pending_replies().await.unwrap();
    let mail = told(&lab, "desk");
    assert_eq!(mail.len(), 1);
    assert_eq!((mail[0]["metadata"]["status"].clone(), items(&mail[0])), (json!("resultArrived"), vec![(1, Some(1))]));
    let body = mail[0]["body"].as_str().unwrap();
    assert!(body.contains("Go back to R-1") && body.contains("replyTo [1]") && body.contains("JSON 好了吗"), "{body}");
    // The Turn it begins ends: told already.
    turn_ended(&lab, "desk");
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(told(&lab, "desk").len(), 1);
    result("r3").await;
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(told(&lab, "desk").len(), 1, "once a SPACING for the request");
    long_ago(&lab);
    result("r4").await;
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(told(&lab, "desk").len(), 2, "after SPACING, back to it again");
    long_ago(&lab);
    answer_alone(&lab, "desk", n, "JSON 好了。", json!([1])).await.unwrap();
    result("r5").await;
    lab.ws.remind_pending_replies().await.unwrap();
    assert_eq!(told(&lab, "desk").len(), 2, "answered: nothing waits");
}

// Whole requests a page; a request with more owed than a page holds goes on
// within it, from the follow-up it stopped before. Walking every page of a
// request with 27 owed among answered ones, and the request after it, names
// each owed item exactly once and no answered one (Dev Lead, seq 12829).
#[tokio::test]
async fn every_page_together_names_each_owed_item_exactly_once() {
    let lab = lab();
    let n = lab.say("第一件", "m1").await;
    lab.route("desk", n, "第一件", "好。", vec![to_agent("第一件", "lead", "开发协调")]).await.unwrap();
    for i in 1..=30 {
        follow(&lab, n, &format!("补充 {i}"), &format!("f{i}")).await;
    }
    // Answered in between, one of them past the first page.
    answer_alone(&lab, "desk", n, "第三条和第十条做了。", json!([10, 3])).await.unwrap();
    answer_alone(&lab, "desk", n, "第二十七条做了。", json!([27])).await.unwrap();
    let next = lab.say("第二件", "m2").await;
    for i in 1..=3 {
        follow(&lab, next, &format!("第二件补充 {i}"), &format!("g{i}")).await;
    }
    answer_alone(&lab, "desk", next, "第二条做了。", json!([2])).await.unwrap();
    let mut seen = Vec::new();
    let mut input = json!({});
    let mut pages = 0;
    loop {
        let page = list(&lab, "desk", input).await.unwrap();
        assert!(page["items"].as_array().unwrap().len() <= 25, "a page holds at most 25");
        seen.extend(labels(&page));
        pages += 1;
        let Some(from) = page.get("nextFromRequest") else { break };
        input = match page.get("nextFromFollowUp") {
            Some(m) => json!({"fromRequest":from,"fromFollowUp":m}),
            None => json!({"fromRequest":from}),
        };
        assert!(pages < 10, "the pages end");
    }
    let mut expected: Vec<String> = (1..=30).filter(|m| ![3, 10, 27].contains(m)).map(|m| format!("R-1 #{m}")).collect();
    expected.extend(["R-2".to_owned(), "R-2 #1".to_owned(), "R-2 #3".to_owned()]);
    assert_eq!(seen, expected, "each owed item once, in order, no answered one");
    assert_eq!(pages, 2, "25 of R-1, then the rest of it with R-2");
    let first = list(&lab, "desk", json!({})).await.unwrap();
    assert_eq!((first["nextFromRequest"].clone(), first["nextFromFollowUp"].clone()), (json!(1), json!(29)));
    assert_eq!(first["owed"], json!({"requests":1,"followUps":29}));
    let error = list(&lab, "desk", json!({"fromFollowUp":3})).await.unwrap_err().to_string();
    assert!(error.starts_with("invalid_input:"), "{error}");
}
