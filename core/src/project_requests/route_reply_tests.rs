//! R-45 (YN-233 S2): the front desk's note names the user's follow-ups it
//! answers (`replyTo`), each one of the same request's, so the page shows an
//! answer only where one was given; a note that names none, as every note
//! from before, reads as answering none. With replyTo the front desk may
//! answer alone, with no title or routes: nothing is routed or retried. A
//! follow-up's message names it by its number, and only the front desk's
//! says how to answer it. Every call here goes through the MCP tool's own
//! entry (collaboration_call), as an Agent's does.
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

/// project_route with request, note and replyTo only (R-45): an answer alone.
async fn answer_alone(lab: &Lab, actor: &str, n: i64, note: &str, reply_to: Value) -> Result<Value> {
    lab.ws.collaboration_call(Some(actor), TOOL, json!({"request":format!("R-{n}"),"note":note,"replyTo":reply_to})).await
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
    // A note in between, then the same answer again, alone and in the other order: still the same answer.
    lab.route("desk", n, "导出", "补一句：先做 JSON。", routes.clone()).await.unwrap();
    answer_alone(&lab, "desk", n, "JSON 和 XML 都加。", json!([2, 1])).await.unwrap();
    assert_eq!(notes(&lab, n).len(), 4, "the same author, words and follow-ups: the same answer, whenever it was written");
    let sends = || (lab.count("SELECT COUNT(*) FROM collaboration_messages"), lab.count("SELECT COUNT(*) FROM agent_receipts"));
    assert_eq!(sends(), (mail, sent), "an answer sends nothing");
    // The same words to a later follow-up are its answer. (The follow-up itself is a message to the front desk.)
    follow(&lab, n, "还有 YAML", "f3").await;
    let (mail, sent) = sends();
    answer_alone(&lab, "desk", n, "JSON 和 XML 都加。", json!([3])).await.unwrap();
    assert_eq!(notes(&lab, n).last().unwrap(), &(5, "JSON 和 XML 都加。".into(), json!([3])));
    // Another front desk saying the same is its own answer.
    let version = front_desk::get(&lab.ws.store, &lab.project).unwrap().version;
    front_desk::save(&lab.ws.store, &lab.project, version, Some("lead".into())).unwrap();
    answer_alone(&lab, "lead", n, "JSON 和 XML 都加。", json!([1, 2])).await.unwrap();
    let all = lab.request(n)["notes"].clone();
    assert_eq!((all.as_array().unwrap().len(), all[5]["by"]["agentId"].clone(), all[5]["replyTo"].clone()), (6, json!("lead"), json!([1, 2])));
    // The notes before replyTo, and those naming none, still name none: none was marked by a later answer.
    assert_eq!((all[0]["replyTo"].clone(), all[3]["replyTo"].clone()), (Value::Null, Value::Null));
    assert_eq!(sends(), (mail, sent), "an answer sends nothing");
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
        let alone = answer_alone(&lab, actor, one, "好。", json!([1])).await.unwrap_err().to_string();
        assert!(alone.starts_with("not_front_desk"), "{actor} alone: {alone}");
    }
    // Alone, an answer names its follow-ups: without a valid replyTo, routes are required as before; an empty list of
    // routes is no answer alone; a title goes with the routes only.
    let alone = answer_alone(&lab, "desk", one, "好。", json!([2])).await.unwrap_err().to_string();
    assert!(alone.starts_with("invalid_input: replyTo names follow-up #2, which R-1 does not have"), "{alone}");
    for (input, expected) in [
        (json!({"request":"R-1","note":"好。"}), "invalid_input: title is required"),
        (json!({"request":"R-1","note":"好。","replyTo":[]}), "invalid_input: replyTo names at least one follow-up"),
        (json!({"request":"R-1","note":"好。","replyTo":[1],"routes":[]}), "invalid_input: title is required"),
        (json!({"request":"R-1","title":"导出","note":"好。","replyTo":[1],"routes":[]}), "invalid_input: routes has 1 to 6 routes, not 0"),
        (json!({"request":"R-1","title":"导出","note":"好。","replyTo":[1]}), "invalid_input: an answer alone (replyTo without routes) keeps the request's title"),
        (json!({"request":"R-1","replyTo":[1]}), "invalid_input: note is required"),
    ] {
        let refused = lab.ws.collaboration_call(Some("desk"), TOOL, input.clone()).await.unwrap_err().to_string();
        assert!(refused.starts_with(expected), "{input}: {refused}");
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

// A follow-up's message names it by its number, and tells the front desk,
// which alone gets it (R-45, the user's choice on YN-233), how to reply to
// it. The page reads whom it went to by name. A follow-up kept from before,
// sent again under its client ID to an Agent that is not the front desk now,
// carries only its number.
#[tokio::test]
async fn a_follow_ups_head_numbers_it_and_tells_the_front_desk_how_to_reply() {
    let lab = lab();
    let carded = lab.say("导出要 CSV", "m1").await;
    let made = lab.route("desk", carded, "导出", "好。", vec![to_agent("导出代码", "lead", "开发协调")]).await.unwrap();
    let reply = follow(&lab, carded, "还要 JSON", "f1").await;
    let to = &reply["deliveredTo"];
    assert_eq!((to.as_array().unwrap().len(), to[0]["agentId"].clone(), to[0]["name"].clone()), (1, json!("desk"), json!("Desk")), "{to}");
    assert!(to[0]["delivery"].is_string() && to[0].get("closed").is_none(), "how its message stands, and its name only: {to}");
    let text = lab.receipt("desk", "f1").unwrap().input.text;
    assert!(text.starts_with("Follow-up #1 to request R-1 from the user"), "{text}");
    assert!(text.contains("project_route with request R-1, your note as the reply and replyTo [1] (no title or routes needed)"), "{text}");
    assert!(text.contains(&format!("Its tasks and who answers for each now: {} (Lead);", made["routes"][0]["task"].as_str().unwrap())), "{text}");
    assert!(lab.receipt("lead", "f1").is_none(), "not to who answers for the card");
    let plain = lab.say("README 做完了吗", "m2").await;
    follow(&lab, plain, "英文版呢？", "f2").await;
    follow(&lab, plain, "还有日文版", "f3").await;
    let text = lab.receipt("desk", "f3").unwrap().input.text;
    assert!(text.starts_with("Follow-up #2 to request R-2 from the user"), "{text}");
    assert!(text.contains("replyTo [2]") && !text.contains("Its tasks"), "{text}");
    // Kept from before R-45, to the Agent then answering for the card: sent again there, with its number only.
    let request: String = lab.ws.store.db.read().unwrap()
        .query_row("SELECT id FROM project_requests WHERE project_id=?1 AND n=?2", params![lab.project, carded], |r| r.get(0)).unwrap();
    lab.ws.store.db.write().unwrap().execute(
        "INSERT INTO project_request_replies(request_id,n,text,text_blocks,at,message_id,delivered_to,images,files)
         VALUES(?1,2,'旧的追问',NULL,?2,'old','[\"lead\"]',NULL,NULL)", params![request, crate::model::now()]).unwrap();
    follow_up(&lab.ws, &lab.project, carded, lab.words("旧的追问", "old")).await.unwrap();
    let text = lab.receipt("lead", "old").unwrap().input.text;
    assert!(text.starts_with("Follow-up #2 to request R-1 from the user") && !text.contains("project_route"), "{text}");
    assert!(lab.receipt("desk", "old").is_none());
}

// Alone, an answer adds only itself: the request keeps its title and its
// routes as recorded, a route that failed stays failed with its error, and
// no route is done, sent again or retried: no task, mail or message.
#[tokio::test]
async fn an_answer_alone_keeps_the_title_and_replays_no_route() {
    let lab = lab();
    let n = lab.say("两件事", "m1").await;
    let routes = vec![to_agent("导出代码", "lead", "开发协调"), join("nothing-here", "试试")];
    let first = lab.route("desk", n, "两件事", "好。", routes).await.unwrap();
    assert_eq!((first["routes"][0]["state"].clone(), first["routes"][1]["state"].clone()), (json!("done"), json!("failed")), "{first}");
    follow(&lab, n, "还要 JSON", "f1").await;
    let before = lab.request(n)["routes"].clone();
    let counts = || {
        (lab.count("SELECT COUNT(*) FROM collaboration_tasks"), lab.count("SELECT COUNT(*) FROM collaboration_messages"),
            lab.count("SELECT COUNT(*) FROM agent_receipts"), lab.count("SELECT COUNT(*) FROM project_routes"))
    };
    let was = counts();
    let answered = answer_alone(&lab, "desk", n, "JSON 也加，见卡片 YN-1。", json!([1])).await.unwrap();
    assert_eq!((answered["title"].clone(), answered["routes"].clone()), (json!("两件事"), json!([])), "{answered}");
    let request = lab.request(n);
    assert_eq!(request["title"], "两件事");
    assert_eq!(request["routes"], before, "every route as it was, the failed one with its error");
    assert_eq!(counts(), was, "nothing routed, sent or retried");
    assert_eq!(notes(&lab, n).last().unwrap(), &(2, "JSON 也加，见卡片 YN-1。".into(), json!([1])));
    // The same routing call as before still tries the failed route again, as it always did.
    let again = lab.route("desk", n, "两件事", "好。", vec![to_agent("导出代码", "lead", "开发协调"), join("nothing-here", "试试")]).await.unwrap();
    assert_eq!(again["routes"][1]["state"], "failed");
    // On a request never routed, an answer alone routes nothing either.
    let plain = lab.say("README 做完了吗", "m2").await;
    follow(&lab, plain, "英文版呢？", "f2").await;
    answer_alone(&lab, "desk", plain, "英文版下周。", json!([1])).await.unwrap();
    let request = lab.request(plain);
    assert_eq!((request["title"].clone(), request["routes"].clone(), request["state"].clone()), (Value::Null, json!([]), json!("waiting")));
}

// The tool's definition says what its parser takes: request and note always;
// title and routes unless replyTo answers alone; its description still fits.
#[test]
fn the_tool_definition_takes_an_answer_alone() {
    let tool = tool_definition();
    assert_eq!(tool["inputSchema"]["required"], json!(["request", "note"]));
    let properties = &tool["inputSchema"]["properties"];
    assert_eq!(properties["replyTo"]["items"]["type"], "integer");
    assert_eq!((properties["replyTo"]["minItems"].clone(), properties["routes"]["minItems"].clone()), (json!(1), json!(1)));
    let description = tool["description"].as_str().unwrap();
    assert!(description.contains("To answer follow-ups only: request, note, replyTo."), "{description}");
    assert!(description.encode_utf16().count() <= 2048);
}
