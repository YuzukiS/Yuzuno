//! YN-212 C3: a card route records its task's card key and puts no card; the
//! task's executor (or its lead) writes it there. A request may join that
//! task before its first card is written: by its live card when there is
//! one, else by a finished card route of this Project that recorded the key
//! for the same task, the key that task's own, and no section ever at it.
//! Every check a join to a live card has holds: the task goes on, someone
//! answers for it, an executor waiting for its slot gets the words by the
//! front desk's mail. No placeholder card is put; once the first card is
//! written, every request routed to the task finds it.
use super::*;

/// The sections the Brief has ever kept at `key`, live or not.
fn rows_at(lab: &Lab, key: &str) -> i64 {
    lab.ws.store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM project_brief_sections WHERE project_id=?1 AND key=?2", params![lab.project, key], |r| r.get(0)).unwrap()
}

/// The card each of the requests `ns` shows for its first task: its identity and key.
fn found(lab: &Lab, ns: &[i64]) -> Vec<(Value, Value)> {
    ns.iter().map(|&n| {
        let card = &lab.request(n)["cards"][0];
        (card["sectionId"].clone(), card["key"].clone())
    }).collect()
}

/// Its slot taken and its first Turn begun, as a slot pass and its dispatch's mail leave it.
fn started(lab: &Lab, agent: &str) {
    lab.ws.store.db.write().unwrap().execute("UPDATE executor_slots SET state='running' WHERE agent_id=?1", [agent]).unwrap();
    running(&lab.ws, agent);
}

/// A second Project, "Other", with its own folder and front desk, Desk 2,
/// its only lead: its project id.
fn other_project(lab: &Lab) -> String {
    let folder = lab.dir.path().join("other");
    std::fs::create_dir_all(&folder).unwrap();
    let folder = std::fs::canonicalize(folder).unwrap().to_string_lossy().into_owned();
    let other = lab.ws.store.create_project("Other", BTreeMap::from([("local".into(), folder)])).unwrap().id;
    lab.ws.store.insert(&agent("desk2", "Desk 2")).unwrap();
    lab.ws.store.set_agent_project("desk2", Some(&other)).unwrap();
    running(&lab.ws, "desk2");
    let version = crate::agent_roles::get(&lab.ws.store, &other).unwrap().version;
    crate::agent_roles::save(&lab.ws.store, &other, version, vec!["desk2".into()]).unwrap();
    front_desk::save(&lab.ws.store, &other, 0, Some("desk2".into())).unwrap();
    other
}

// The lead's case A (seq 16141): a request joins a task routed here before
// its first card is written. The join is done, no card is put for it, and
// it goes to who answers for the task; once the first card is written both
// requests find it, and a later join goes to it as to any live card.
#[tokio::test]
async fn a_request_joins_a_task_whose_first_card_is_still_to_come_and_both_find_it_once_written() {
    let lab = lab();
    let first = lab.say("导出要 CSV", "m1").await;
    let made = lab.route("desk", first, "导出功能", "好。", vec![to_agent("导出功能", "lead", "开发协调")]).await.unwrap();
    let key = made["routes"][0]["task"].as_str().unwrap().to_owned();
    let card = key.to_lowercase();
    let second = lab.say("还要 JSON", "m2").await;
    let joined = lab.route("desk", second, "导出 JSON", "并进导出。", vec![join(&card, "同一件事")]).await.unwrap();
    let route = &joined["routes"][0];
    assert_eq!((route["state"].clone(), route["to"]["agentId"].clone(), route["task"].clone(), route["cardKey"].clone(), route["sectionId"].clone()),
        (json!("done"), json!("lead"), json!(key), json!(card), Value::Null), "{joined}");
    assert!(lab.receipt("lead", &format!("route-{}", lab.route_id(second, 0))).is_some(), "the words reached who answers for the task");
    assert_eq!(rows_at(&lab, &card), 0, "no card put for the join");
    assert_eq!(found(&lab, &[first, second]), [(Value::Null, Value::Null), (Value::Null, Value::Null)]);
    assert_eq!(lab.request(second)["cards"][0]["task"]["id"], json!(key));
    // The first card: both requests find it, its handoffs name both.
    let identity = lab.write_card("lead", &key).await;
    assert_eq!(found(&lab, &[first, second]), [(json!(identity), json!(card)), (json!(identity), json!(card))]);
    let requests = &lab.section(&card).await.unwrap()["card"]["handoffs"]["requests"];
    assert_eq!(requests.as_array().unwrap().iter().map(|r| (r["n"].clone(), r["merged"].clone())).collect::<Vec<_>>(),
        [(json!(1), json!(false)), (json!(2), json!(true))]);
    // A join now goes to the live card.
    let third = lab.say("还要 XML", "m3").await;
    let later = lab.route("desk", third, "导出 XML", "并进导出。", vec![join(&card, "同一件事")]).await.unwrap();
    assert_eq!((later["routes"][0]["state"].clone(), later["routes"][0]["sectionId"].clone()), (json!("done"), json!(identity)), "{later}");
    assert_eq!(found(&lab, &[third]), [(json!(identity), json!(card))]);
}

// The lead's case A: a join and the first card at once, in either order,
// reach the same card, and the words go once; the same call again sends
// nothing more. A join refused before the first card (more than a queued
// executor's mail holds) recorded nothing, and once the executor has
// started and written its card, its retry goes to that card, the words once.
#[tokio::test]
async fn a_join_and_the_first_card_at_once_or_again_reach_the_card_once() {
    let lab = lab();
    let first = lab.say("导出要 CSV", "m1").await;
    let made = lab.route("desk", first, "导出功能", "好。", vec![to_agent("导出功能", "lead", "开发协调")]).await.unwrap();
    let key = made["routes"][0]["task"].as_str().unwrap().to_owned();
    let card = key.to_lowercase();
    let second = lab.say("还要 JSON", "m2").await;
    let call = vec![join(&card, "同一件事")];
    let (joined, identity) = tokio::join!(lab.route("desk", second, "导出 JSON", "并进导出。", call.clone()), lab.write_card("lead", &key));
    let joined = joined.unwrap();
    assert_eq!(joined["routes"][0]["state"], "done", "{joined}");
    assert!([Value::Null, json!(identity)].contains(&joined["routes"][0]["sectionId"]), "{joined}");
    assert_eq!(found(&lab, &[first, second]), [(json!(identity), json!(card)), (json!(identity), json!(card))]);
    assert_eq!(rows_at(&lab, &card), 1, "the card the lead wrote, and no other");
    let why = |lab: &Lab| lab.mail("lead").into_iter().filter(|m| m["sender"]["id"] == "desk" && m["dispatchId"].is_null()).count();
    assert_eq!((lab.sent("lead"), why(&lab)), (1, 1));
    lab.route("desk", second, "导出 JSON", "并进导出。", call).await.unwrap();
    assert_eq!((lab.sent("lead"), why(&lab)), (1, 1), "again: nothing more");

    // A join refused before the first card, retried after it.
    let n = lab.say("设置页重新排版", "m3").await;
    let made = lab.route("desk", n, "设置页排版", "好。", vec![design("设置页排版", "要设计")]).await.unwrap();
    let (task, executor) = (made["routes"][0]["task"].as_str().unwrap().to_owned(), made["routes"][0]["to"]["agentId"].as_str().unwrap().to_owned());
    let long = lab.say(&"长".repeat(crate::collaboration_store::MAX_MAIL_BODY / 3), "m4").await;
    let call = vec![join(&task.to_lowercase(), "同一张设置页")];
    let refused = lab.route("desk", long, "很长的补充", "等它开始。", call.clone()).await.unwrap();
    assert!(refused["routes"][0]["error"].as_str().unwrap().starts_with("executor_queued"), "{refused}");
    assert_eq!((refused["routes"][0]["task"].clone(), refused["routes"][0]["cardKey"].clone()), (Value::Null, Value::Null), "nothing recorded");
    started(&lab, &executor);
    let identity = lab.write_card(&executor, &task).await;
    let again = lab.route("desk", long, "很长的补充", "等它开始。", call.clone()).await.unwrap();
    assert_eq!((again["routes"][0]["state"].clone(), again["routes"][0]["sectionId"].clone()), (json!("done"), json!(identity)), "{again}");
    assert_eq!(found(&lab, &[n, long]), [(json!(identity), json!(task.to_lowercase())), (json!(identity), json!(task.to_lowercase()))]);
    assert_eq!(lab.sent(&executor), 1, "the words, as a message from Home now it has started");
    lab.route("desk", long, "很长的补充", "等它开始。", call).await.unwrap();
    assert_eq!(lab.sent(&executor), 1, "once");
}

// The lead's case A: what no first card is still to come for. Another
// Project's task, before or after its card is written; a task here that has
// ended; a key here that held the task's card, since removed; and a key here
// that another section holds, bound to no task. Each join fails, recording
// nothing and sending nothing.
#[tokio::test]
async fn a_join_is_refused_for_another_projects_task_an_ended_one_or_a_key_that_held_another_section() {
    let lab = lab();
    let refused = |answer: &Value, code: &str| {
        let route = &answer["routes"][0];
        assert_eq!(route["state"], "failed", "{answer}");
        assert!(route["error"].as_str().unwrap().starts_with(code), "{code}: {answer}");
        assert_eq!((route["task"].clone(), route["cardKey"].clone(), route["sectionId"].clone()), (Value::Null, Value::Null, Value::Null), "{answer}");
    };
    // Another Project's task, routed by its own front desk.
    let other = other_project(&lab);
    let there = submit(&lab.ws, &other, lab.words("别处的事", "o1")).await.unwrap()["request"]["n"].as_i64().unwrap();
    let made = lab.ws.collaboration_call(Some("desk2"), TOOL, json!({"request":format!("R-{there}"),"title":"别处","note":"好。",
        "routes":[to_agent("别处", "desk2", "我来")]})).await.unwrap();
    assert_eq!(made["routes"][0]["state"], "done", "{made}");
    let elsewhere = made["routes"][0]["task"].as_str().unwrap().to_owned();
    let n = lab.say("也做别处那件", "m1").await;
    refused(&lab.route("desk", n, "别处", "试试。", vec![join(&elsewhere.to_lowercase(), "同一件事")]).await.unwrap(), "not_a_card");
    let version = lab.ws.collaboration_call(Some("desk2"), "brief_get", json!({"keys":[]})).await.unwrap()["version"].clone();
    lab.ws.collaboration_call(Some("desk2"), "brief_update", json!({"requestId":"other-card","expectedVersion":version,"changes":[{"op":"put",
        "key":elsewhere.to_lowercase(),"kind":"status","title":"别处","markdown":"进行中。","status":{"asOf":crate::model::now(),"validFor":3600},
        "task":elsewhere}]})).await.unwrap();
    refused(&lab.route("desk", n, "别处", "试试。", vec![join(&elsewhere.to_lowercase(), "同一件事")]).await.unwrap(), "not_a_card");

    // Three tasks here: one ends before its first card, one has its card
    // written and removed, one has another section put at its key.
    let three = lab.say("三件事", "m2").await;
    let made = lab.route("desk", three, "三件事", "好。", vec![design("设置页", "要设计"), to_agent("文档", "lead", "写"), to_agent("说明", "lead", "写")])
        .await.unwrap();
    let key = |index: usize| made["routes"][index]["task"].as_str().unwrap().to_lowercase();
    let task = |index: usize| made["routes"][index]["task"].as_str().unwrap().to_owned();
    lab.end(&task(0), "cancelled");
    let late = lab.say("设置页再加一项", "m3").await;
    refused(&lab.route("desk", late, "设置页", "试试。", vec![join(&key(0), "同一件事")]).await.unwrap(), "card_ended");
    lab.write_card("lead", &task(1)).await;
    lab.brief("lead", json!({"op":"remove","key":key(1)})).await;
    let removed = lab.say("文档再加一节", "m4").await;
    refused(&lab.route("desk", removed, "文档", "试试。", vec![join(&key(1), "同一件事")]).await.unwrap(), "not_a_card");
    let body = json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["t"]},"t":{"type":"Markdown","props":{"text":"笔记"}}}});
    lab.brief("lead", json!({"op":"put","key":key(2),"kind":"report","title":"笔记","body":body})).await;
    let taken = lab.say("说明再改", "m5").await;
    refused(&lab.route("desk", taken, "说明", "试试。", vec![join(&key(2), "同一件事")]).await.unwrap(), "not_a_card");
    let executor = made["routes"][0]["to"]["agentId"].as_str().unwrap().to_owned();
    assert_eq!((lab.sent("lead"), lab.sent(&executor), lab.sent("desk2")), (0, 0, 1), "nothing sent but Desk 2's own request, as said");
}

// YN-212 C3: a card an older Core's route put, still as it put it (a status
// of the front desk's with a lead "→ …" and the task's Live References
// alone, the route's section), reads as that route's placeholder, which
// Home shows by its words only; once anyone writes the card it is the
// task's card.
#[tokio::test]
async fn a_card_an_older_route_put_reads_as_its_placeholder_until_written() {
    let lab = lab();
    let n = lab.say("设置页重新排版", "m1").await;
    let made = lab.route("desk", n, "设置页排版", "好。", vec![to_agent("设置页排版", "lead", "开发协调")]).await.unwrap();
    let key = made["routes"][0]["task"].as_str().unwrap().to_owned();
    let card = key.to_lowercase();
    let body = json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["lead","refs"]},
        "lead":{"type":"Markdown","props":{"text":"→ Lead · 开发协调"}},
        "refs":{"type":"LiveRefs","props":{"items":[{"kind":"task","id":key}]}}}});
    lab.brief("desk", json!({"op":"put","key":card,"kind":"status","title":"设置页排版","body":body,
        "status":{"asOf":crate::model::now(),"validFor":86400},"task":key})).await;
    let identity: i64 = lab.ws.store.db.read().unwrap().query_row(
        "SELECT COALESCE(lineage,seq) FROM project_brief_sections WHERE project_id=?1 AND key=?2 AND live=1",
        params![lab.project, card], |r| r.get(0)).unwrap();
    // As an older Core's route recorded it.
    lab.ws.store.db.write().unwrap()
        .execute("UPDATE project_routes SET section_id=?2 WHERE id=?1", params![lab.route_id(n, 0), identity]).unwrap();
    assert_eq!(lab.section(&card).await.unwrap()["card"]["placeholder"], json!(true));
    assert_eq!(lab.request(n)["cards"][0]["sectionId"], json!(identity), "the request finds it as its route recorded it");
    // Its lead writes the card: the task's card, no placeholder.
    lab.write_card("lead", &key).await;
    let written = lab.section(&card).await.unwrap();
    assert!(written["card"].get("placeholder").is_none(), "{written}");
    assert_eq!(written["owner"]["agentId"], "desk", "its owner stays");
}

/// `agent` puts task `task`'s card at its key, bound to it, as `write_card`
/// does: Core's answer, or its refusal.
async fn put_card(lab: &Lab, agent: &str, task: &str, text: &str) -> anyhow::Result<Value> {
    let version = lab.ws.collaboration_call(Some(agent), "brief_get", json!({"keys":[]})).await.unwrap()["version"].clone();
    lab.ws.collaboration_call(Some(agent), "brief_update", json!({"requestId":uuid::Uuid::new_v4().to_string(),"expectedVersion":version,
        "changes":[{"op":"put","key":task.to_lowercase(),"kind":"status","title":format!("{task} 进展"),"markdown":text,
        "status":{"asOf":crate::model::now(),"validFor":3600},"task":task}]})).await
}

// PR 1091 R1 (P2): a card route to an Agent here that leads nothing and
// executes nothing gives it the task (its assignee) and puts no card. It
// answers for the task, so it writes the task's first card at the task's
// key, as an executor would, and keeps writing it; the request finds the
// card there. Another Agent of the Project binds nothing to that task.
// Reassigned from the page to that other Agent, the first writes it no
// more and the other does; the card stays the first one's.
#[tokio::test]
async fn an_agent_given_a_card_route_writes_its_tasks_card_and_another_does_not() {
    let lab = lab();
    lab.ws.store.insert(&agent("other", "Other")).unwrap();
    lab.ws.store.set_agent_project("other", Some(&lab.project)).unwrap();
    running(&lab.ws, "other");
    let n = lab.say("写导出文档", "m1").await;
    let made = lab.route("desk", n, "导出文档", "好。", vec![to_agent("导出文档", "member", "写文档")]).await.unwrap();
    let task = made["routes"][0]["task"].as_str().unwrap().to_owned();
    let key = task.to_lowercase();
    assert_eq!(lab.task(&task)["assignee"]["id"], "member");
    assert_eq!(rows_at(&lab, &key), 0, "routing puts no card");

    let refused = put_card(&lab, "other", &task, "我来写。").await.unwrap_err().to_string();
    assert!(refused.contains("invalid_task"), "not its task: {refused}");
    assert_eq!(rows_at(&lab, &key), 0);
    let identity = lab.write_card("member", &task).await;
    assert_eq!(found(&lab, &[n]), [(json!(identity), json!(key))], "the request finds the card it wrote");
    put_card(&lab, "member", &task, "写了一半。").await.unwrap();
    assert_eq!(lab.section(&key).await.unwrap()["card"]["responsible"]["agentId"], "member");

    let body = json!({"workspaceId":lab.workspace,"to":{"agentId":"other"},"why":"换人写","clientRequestId":"r1"});
    let (status, answer) = reassign_on_page(&lab, &json!(identity), body, false).await;
    assert_eq!(status, StatusCode::OK, "{answer}");
    let refused = put_card(&lab, "member", &task, "还是我。").await.unwrap_err().to_string();
    assert!(refused.contains("invalid_task"), "no longer its task: {refused}");
    put_card(&lab, "other", &task, "接手了。").await.unwrap();
    let card = lab.section(&key).await.unwrap();
    assert_eq!((card["owner"]["agentId"].clone(), card["author"]["agentId"].clone(), card["card"]["responsible"]["agentId"].clone()),
        (json!("member"), json!("other"), json!("other")));
    assert_eq!(found(&lab, &[n]), [(json!(identity), json!(key))], "the same card");
}
