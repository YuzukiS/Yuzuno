//! R-45 (YN-233 S2): the front desk's note names the user's follow-ups it
//! answers (`replyTo`), each one of the same request's, so the page shows an
//! answer only where one was given; a note that names none, as every note
//! from before, reads as answering none. A follow-up's message names it by
//! its number, and only the front desk's says how to answer it.
use super::*;

/// The user follows up request `n` with `text`: its number.
async fn follow(lab: &Lab, n: i64, text: &str, id: &str) -> Value {
    follow_up(&lab.ws, &lab.project, n, lab.words(text, id)).await.unwrap()["reply"].clone()
}

async fn answer_with(lab: &Lab, actor: &str, n: i64, note: &str, routes: Vec<Value>, reply_to: Value) -> Result<Value> {
    lab.ws
        .collaboration_call(Some(actor), TOOL, json!({"request":format!("R-{n}"),"title":"导出","note":note,"routes":routes,"replyTo":reply_to}))
        .await
}

fn notes(lab: &Lab, n: i64) -> Vec<(i64, String, Value)> {
    lab.request(n)["notes"].as_array().unwrap().iter()
        .map(|note| (note["n"].as_i64().unwrap(), note["note"].as_str().unwrap().to_owned(), note["replyTo"].clone()))
        .collect()
}

// A note answers the follow-ups it names, ascending and each once; one that
// names none reads as null. Said again with the same replyTo it is the same
// note; said again naming other follow-ups it is a new one; said again
// naming none it is no new note, as before.
#[tokio::test]
async fn a_note_answers_the_follow_ups_it_names_and_saying_it_again_is_the_same_note() {
    let lab = lab();
    let n = lab.say("导出要 CSV", "m1").await;
    let routes = vec![to_agent("导出代码", "lead", "开发协调")];
    lab.route("desk", n, "导出", "好。", routes.clone()).await.unwrap();
    follow(&lab, n, "还要 JSON", "f1").await;
    follow(&lab, n, "再加 XML", "f2").await;
    let answered = answer_with(&lab, "desk", n, "JSON 和 XML 都加。", routes.clone(), json!([2, 1, 2])).await.unwrap();
    assert_eq!(answered["routes"].as_array().unwrap().len(), 1, "{answered}");
    assert_eq!(notes(&lab, n), [(1, "好。".into(), Value::Null), (2, "JSON 和 XML 都加。".into(), json!([1, 2]))]);
    let (mail, sent) = (lab.count("SELECT COUNT(*) FROM collaboration_messages"), lab.count("SELECT COUNT(*) FROM agent_receipts"));
    answer_with(&lab, "desk", n, "JSON 和 XML 都加。", routes.clone(), json!([1, 2])).await.unwrap();
    assert_eq!(notes(&lab, n).len(), 2, "the same note and replyTo again is the same note");
    lab.route("desk", n, "导出", "JSON 和 XML 都加。", routes.clone()).await.unwrap();
    assert_eq!(notes(&lab, n).len(), 2, "said again naming none: no new note, as before");
    answer_with(&lab, "desk", n, "JSON 和 XML 都加。", routes.clone(), json!([1])).await.unwrap();
    assert_eq!(notes(&lab, n).last().unwrap(), &(3, "JSON 和 XML 都加。".into(), json!([1])), "naming other follow-ups: a new note");
    assert_eq!(
        (lab.count("SELECT COUNT(*) FROM collaboration_messages"), lab.count("SELECT COUNT(*) FROM agent_receipts")),
        (mail, sent),
        "an answer sends nothing"
    );
}

// Every follow-up it names must be the same request's: one of another
// request, or one not made yet, refuses the call whole before anything is
// written (no title, no route, no note); so does a malformed replyTo, and a
// call from anyone but the front desk.
#[tokio::test]
async fn a_reply_to_a_follow_up_the_request_does_not_have_is_refused_whole() {
    let lab = lab();
    let one = lab.say("导出要 CSV", "m1").await;
    let two = lab.say("设置页排版", "m2").await;
    follow(&lab, one, "还要 JSON", "f1").await;
    let routes = vec![to_agent("导出代码", "lead", "开发协调")];
    let elsewhere = answer_with(&lab, "desk", two, "好。", routes.clone(), json!([1])).await.unwrap_err().to_string();
    assert!(elsewhere.starts_with("invalid_input: replyTo names follow-up #1, which R-2 does not have"), "{elsewhere}");
    let later = answer_with(&lab, "desk", one, "好。", routes.clone(), json!([1, 3])).await.unwrap_err().to_string();
    assert!(later.starts_with("invalid_input: replyTo names follow-up #3, which R-1 does not have"), "{later}");
    for (given, expected) in [
        (json!([]), "invalid_input: replyTo names at least one follow-up"),
        (json!([0]), "invalid_input: replyTo has 0"),
        (json!(["1"]), "invalid_input: replyTo has \"1\""),
        (json!(1), "invalid_input: replyTo is a list"),
    ] {
        let refused = answer_with(&lab, "desk", one, "好。", routes.clone(), given.clone()).await.unwrap_err().to_string();
        assert!(refused.starts_with(expected), "{given}: {refused}");
    }
    for actor in ["lead", "member"] {
        let refused = answer_with(&lab, actor, one, "好。", routes.clone(), json!([1])).await.unwrap_err().to_string();
        assert!(refused.starts_with("not_front_desk"), "{actor}: {refused}");
    }
    assert_eq!(lab.count("SELECT COUNT(*) FROM project_routes"), 0, "no route recorded");
    assert_eq!(lab.count("SELECT COUNT(*) FROM project_request_notes"), 0, "no note");
    assert_eq!(lab.count("SELECT COUNT(*) FROM collaboration_tasks"), 0, "no task");
    assert_eq!((lab.request(one)["title"].clone(), lab.request(two)["title"].clone()), (Value::Null, Value::Null));
    // Its own follow-up: answered.
    answer_with(&lab, "desk", one, "好，JSON 也加。", routes, json!([1])).await.unwrap();
    assert_eq!(notes(&lab, one), [(1, "好，JSON 也加。".into(), json!([1]))]);
}

// A Core from before R-45 kept notes with no reply_to: opened by this one,
// the column is added and each of them reads as answering none.
#[tokio::test]
async fn notes_from_before_reply_to_read_as_answering_none() {
    let lab = lab();
    let n = lab.say("README 做完了吗", "m1").await;
    lab.route("desk", n, "README 进度", "做完了。", vec![answer("只问进度")]).await.unwrap();
    {
        let db = lab.ws.store.db.write().unwrap();
        db.execute_batch("ALTER TABLE project_request_notes DROP COLUMN reply_to").unwrap();
        // Twice: it runs on every open, and adds the column once.
        super::super::migrate(&db).unwrap();
        super::super::migrate(&db).unwrap();
    }
    assert_eq!(notes(&lab, n), [(1, "做完了。".into(), Value::Null)]);
    assert_eq!(lab.request(n)["state"], "answered");
}

// A follow-up's message names it by its number. The front desk's says how to
// answer it, by that number; an Agent answering for a card is told only the
// number. The page reads who it went to by name, and whether they are closed.
#[tokio::test]
async fn a_follow_ups_head_numbers_it_and_tells_only_the_front_desk_how_to_answer() {
    let lab = lab();
    let carded = lab.say("导出要 CSV", "m1").await;
    lab.route("desk", carded, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调")]).await.unwrap();
    let reply = follow(&lab, carded, "还要 JSON", "f1").await;
    let to = &reply["deliveredTo"];
    assert_eq!((to.as_array().unwrap().len(), to[0]["agentId"].clone(), to[0]["name"].clone(), to[0]["closed"].clone()),
        (1, json!("lead"), json!("Lead"), json!(false)), "{to}");
    assert!(to[0]["delivery"].is_string(), "with how its message stands: {to}");
    let text = lab.receipt("lead", "f1").unwrap().input.text;
    assert!(text.starts_with("Follow-up #1 to request R-1 from the user"), "{text}");
    assert!(!text.contains("project_route"), "only the front desk answers in the conversation: {text}");
    let plain = lab.say("README 做完了吗", "m2").await;
    follow(&lab, plain, "英文版呢？", "f2").await;
    follow(&lab, plain, "还有日文版", "f3").await;
    let text = lab.receipt("desk", "f3").unwrap().input.text;
    assert!(text.starts_with("Follow-up #2 to request R-2 from the user"), "{text}");
    assert!(text.contains("project_route request R-2 with replyTo [2]"), "{text}");
    lab.ws.store.update("lead", "test/closed", &json!({}), |d| d.agent.closed_at = Some(crate::model::now())).unwrap();
    assert_eq!(lab.request(carded)["replies"][0]["deliveredTo"][0]["closed"], true);
}
