//! YN-237 ①: the first page of a Project's requests keeps, beside its own, the
//! older requests still going on or routed to a task a live card is of, so
//! Home draws every card in its request's block whatever page the request is
//! on. The page itself, and paging by it, stay as they were.
use super::*;
use crate::project_requests::page_for;

fn read(lab: &Lab, before: Option<i64>, limit: usize) -> Value {
    page_for(&lab.ws.store.db.read().unwrap(), &lab.project, before, Some(limit), None).unwrap()
}

fn numbers(page: &Value, field: &str) -> Vec<i64> {
    page[field].as_array().unwrap().iter().map(|request| request["n"].as_i64().unwrap()).collect()
}

/// The task the newest route of `made` made.
fn task_of(made: &Value) -> String {
    made["routes"][0]["task"].as_str().unwrap().to_owned()
}

#[tokio::test]
async fn the_first_page_keeps_older_requests_going_on_or_bound_to_a_live_card() {
    let lab = lab();
    // R-1 goes on; R-2's task ended with its card; R-3 waits for its front desk; R-4 was answered with no card; R-5's
    // task ended while an Ask on it is still open; R-6 and R-7 are the newest.
    let going = lab.say("一", "m1").await;
    lab.route("desk", going, "一", "好。", vec![to_agent("一", "lead", "做")]).await.unwrap();
    let ended = lab.say("二", "m2").await;
    let done = task_of(&lab.route("desk", ended, "二", "好。", vec![to_agent("二", "lead", "做")]).await.unwrap());
    lab.write_card("lead", &done).await;
    lab.end(&done, "done");
    let waiting = lab.say("三", "m3").await;
    let answered = lab.say("四", "m4").await;
    lab.route("desk", answered, "四", "已答。", vec![answer("只问一句")]).await.unwrap();
    let asked = lab.say("五", "m5").await;
    let outlived = task_of(&lab.route("desk", asked, "五", "好。", vec![to_agent("五", "lead", "做")]).await.unwrap());
    let body = json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["t"]},"t":{"type":"Markdown","props":{"text":"两种做法"}}}});
    lab.brief("lead", json!({"op":"put","key":format!("{}/pick", outlived.to_lowercase()),"kind":"ask","title":"选一种","body":body,
        "ask":{"question":"选哪种？","reply":{"options":[{"id":"a","label":"A"},{"id":"b","label":"B"}]}},"task":outlived})).await;
    lab.end(&outlived, "done");
    lab.say("六", "m6").await;
    lab.say("七", "m7").await;

    let first = read(&lab, None, 2);
    assert_eq!(numbers(&first, "requests"), [7, 6]);
    assert_eq!(first["hasMore"], true);
    assert_eq!(numbers(&first, "kept"), [asked, waiting, going], "newest first: not R-2, its card gone, nor R-4, answered");
    let kept = &first["kept"].as_array().unwrap();
    assert_eq!((kept[2]["state"].clone(), kept[1]["state"].clone(), kept[0]["state"].clone()), (json!("doing"), json!("waiting"), json!("ended")),
        "each as its own page shows it");
    assert_eq!(kept[0]["cards"][0]["task"]["id"], json!(outlived));

    // Paging goes by the page's own requests: the next page lists R-5 and R-4 as before, and keeps nothing.
    let next = read(&lab, Some(6), 2);
    assert_eq!((numbers(&next, "requests"), numbers(&next, "kept")), (vec![asked, answered], vec![]));
    // A first page that holds them all keeps none.
    assert_eq!(numbers(&read(&lab, None, 50), "kept"), Vec::<i64>::new());

    // Once the Ask is resolved, R-5's task is no live card's: it only waits for the user's confirmation, on its own page.
    lab.brief("lead", json!({"op":"resolve","key":format!("{}/pick", outlived.to_lowercase())})).await;
    assert_eq!(numbers(&read(&lab, None, 2), "kept"), [waiting, going]);
}
