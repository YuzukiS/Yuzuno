use super::*;

/// When `key`'s history row (its newest) became history.
fn left_at(ws: &Workspace, project: &str, key: &str) -> String {
    ws.store.db.read().unwrap()
        .query_row("SELECT history_at FROM project_brief_sections WHERE project_id=?1 AND key=?2 AND live=0 ORDER BY seq DESC LIMIT 1",
            [project, key], |r| r.get(0))
        .unwrap()
}

fn reason(rejected: &Value) -> String {
    rejected["problems"][0]["reason"].as_str().unwrap_or_default().to_owned()
}

/// YN-7 item 1: a report the user marks seen leaves brief_get's sections and
/// its owner's ownsKeys at once. Its owner reads that it left, why and when,
/// until it writes the key again; another Agent does not.
#[tokio::test]
async fn a_report_the_user_marked_seen_is_in_its_owners_recently_left_with_why_and_when() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("result", "report"), put("load", "status")])).await;
    let marked = sections::mark_seen(&ws.store, &project, &[("result".into(), 1)]).unwrap();
    assert_eq!(marked["archived"], json!(["result"]));
    let read = brief(&ws, "a");
    assert_eq!(section(&read, "result"), &Value::Null, "a seen report is not among the sections");
    assert_eq!(read["you"]["ownsKeys"], json!(["load"]));
    let at = left_at(&ws, &project, "result");
    assert_eq!(read["you"]["recentlyLeft"], json!([{"key":"result","kind":"report","title":"About result","version":1,
        "reason":"seen","at":at}]), "the owner reads that its report left because the user saw it");
    assert_eq!(read["you"]["recentlyLeftMore"], 0, "nothing beyond");
    assert_eq!(brief(&ws, "b")["you"]["recentlyLeft"], json!([]), "another Agent's section is not yours");
    // Written again, it is live and no longer listed.
    accept(&ws, "a", input("a2", version(&ws, &project), vec![put("result", "report")])).await;
    let read = brief(&ws, "a");
    assert_eq!(section(&read, "result")["version"], 2);
    assert_eq!(read["you"]["recentlyLeft"], json!([]), "a key written again is live, not left");
}

/// Removed and resolved sections are listed too, newest first, each as the
/// version that left (a resolve is a version of its own); history older
/// than its days is not.
#[tokio::test]
async fn removed_and_resolved_sections_are_listed_newest_first_within_historys_days() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("old", "report"), put("state", "status"), put("decide", "ask")])).await;
    accept(&ws, "a", input("a2", version(&ws, &project), vec![op("remove", "old")])).await;
    accept(&ws, "a", input("a3", version(&ws, &project), vec![op("remove", "state")])).await;
    accept(&ws, "a", input("a4", version(&ws, &project), vec![op("resolve", "decide")])).await;
    let left = brief(&ws, "a")["you"]["recentlyLeft"].clone();
    let shown: Vec<(&str, &str, i64)> = left.as_array().into_iter().flatten()
        .map(|entry| (entry["key"].as_str().unwrap_or_default(), entry["reason"].as_str().unwrap_or_default(), entry["version"].as_i64().unwrap_or_default()))
        .collect();
    assert_eq!(shown, vec![("decide", "resolved", 2), ("state", "removed", 1), ("old", "removed", 1)], "newest first, each as the version that left");
    assert_eq!(left[1]["kind"], "status");
    // Past history's days, a section is not recent.
    let old = (chrono::Utc::now() - chrono::Duration::days(HISTORY_DAYS + 1)).to_rfc3339();
    ws.store.db.write().unwrap()
        .execute("UPDATE project_brief_sections SET history_at=?2 WHERE project_id=?1 AND key='old'", [&project, &old])
        .unwrap();
    let keys: Vec<Value> = brief(&ws, "a")["you"]["recentlyLeft"].as_array().into_iter().flatten().map(|e| e["key"].clone()).collect();
    assert_eq!(keys, vec![json!("decide"), json!("state")], "past history's days, not recent");
}

/// A key's newest row says whose it is: a report of a's the user saw, then
/// written and removed by b, is b's to list, not a's.
#[tokio::test]
async fn a_key_last_left_under_another_agent_is_only_theirs_to_list() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("topic", "report")])).await;
    sections::mark_seen(&ws.store, &project, &[("topic".into(), 1)]).unwrap();
    accept(&ws, "b", input("b1", version(&ws, &project), vec![put("topic", "report")])).await;
    accept(&ws, "b", input("b2", version(&ws, &project), vec![op("remove", "topic")])).await;
    assert_eq!(brief(&ws, "a")["you"]["recentlyLeft"], json!([]), "the key last left under b");
    let left = brief(&ws, "b")["you"]["recentlyLeft"].clone();
    let shown: Vec<(Value, Value)> = left.as_array().into_iter().flatten().map(|e| (e["key"].clone(), e["reason"].clone())).collect();
    assert_eq!(shown, vec![(json!("topic"), json!("removed"))], "b's to list");
}

/// At most 20 are listed, the newest; recentlyLeftMore counts the rest.
#[tokio::test]
async fn recently_left_lists_the_newest_twenty_and_counts_the_rest() {
    let (_dir, ws, project) = lab();
    // 12 topics at most at once: two rounds of put, then remove.
    for (round, keys) in [(1, 1..=12), (2, 13..=23)] {
        let keys: Vec<String> = keys.map(|i| format!("k{i}")).collect();
        let puts = keys.iter().map(|key| put(key, "report")).collect();
        accept(&ws, "a", input(&format!("put{round}"), version(&ws, &project), puts)).await;
        let removes = keys.iter().map(|key| op("remove", key)).collect();
        accept(&ws, "a", input(&format!("remove{round}"), version(&ws, &project), removes)).await;
    }
    let you = brief(&ws, "a")["you"].clone();
    let keys: Vec<&str> = you["recentlyLeft"].as_array().into_iter().flatten().map(|e| e["key"].as_str().unwrap_or_default()).collect();
    let newest: Vec<String> = (4..=23).rev().map(|i| format!("k{i}")).collect();
    assert_eq!(keys, newest, "the newest 20, newest first");
    assert_eq!(you["recentlyLeftMore"], 3, "the rest, counted");
}

/// A change naming its owner's section that left says why; another Agent,
/// or a key an earlier change of the same update took out, reads the plain
/// reason.
#[tokio::test]
async fn a_change_naming_your_section_that_left_says_why_it_left() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("result", "report"), put("gone", "report"), put("here", "report")])).await;
    sections::mark_seen(&ws.store, &project, &[("result".into(), 1)]).unwrap();
    let at = left_at(&ws, &project, "result");
    let edit = json!({"op":"edit","key":"result","elements":{"note":{"type":"Markdown","props":{"text":"More"}}}});
    let edited = reject(&ws, "a", input("a2", version(&ws, &project), vec![edit.clone()])).await;
    assert_eq!(codes(&edited), ["not_found"]);
    assert_eq!(reason(&edited), format!("No live section has key result, so there is nothing to edit. The user marked your report seen at {at}, \
        so it left the live Brief; put it again under this key to continue it on Home."));
    let removed = reject(&ws, "a", input("a3", version(&ws, &project), vec![op("remove", "result")])).await;
    assert!(reason(&removed).starts_with(&format!("No live section has key result. The user marked your report seen at {at}")), "{removed}");
    // Not the owner of how it left: the plain reason.
    let other = reject(&ws, "b", input("b1", version(&ws, &project), vec![edit])).await;
    assert_eq!(reason(&other), "No live section has key result; create it with put.");
    accept(&ws, "a", input("a4", version(&ws, &project), vec![op("remove", "gone")])).await;
    let gone = reject(&ws, "a", input("a5", version(&ws, &project), vec![op("remove", "gone")])).await;
    assert_eq!(reason(&gone), format!("No live section has key gone. You removed it at {}.", left_at(&ws, &project, "gone")));
    // Taken out earlier in the same update: nothing of an older ending.
    let twice = reject(&ws, "a", input("a6", version(&ws, &project), vec![op("remove", "here"), op("remove", "here")])).await;
    assert_eq!(reason(&twice), "No live section has key here.");
}
