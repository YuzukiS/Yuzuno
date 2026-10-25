use super::{
    attachments, home, presentation, sections,
    update::{self, Checker},
    *,
};
use crate::model::AgentDetail;
use std::collections::BTreeMap;

/// Stands in for the generated validator: a section titled INVALID is
/// rejected, everything else comes back as sent.
fn fake(section: &Value) -> Result<Value, Value> {
    if section["title"] == "INVALID" {
        return Err(json!([{"code":"invalid_body","path":"body","reason":"Not a body.","guide":"brief_guide content"}]));
    }
    Ok(section.clone())
}
const FAKE: Checker = Checker::Fake(fake);

fn agent(id: &str) -> AgentDetail {
    serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/tmp","model":"test","color":"sage",
        "threadId":format!("session-{id}"),"status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
        "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))
    .unwrap()
}

/// Connected and working on `turn`, every earlier Turn completed.
fn running(ws: &Workspace, id: &str, turn: &str) {
    ws.store
        .update(id, "test/running", &json!({}), |d| {
            for t in &mut d.turns {
                t["status"] = json!("completed");
            }
            d.turns.push(json!({"id":turn,"status":"inProgress","items":[]}));
            d.agent.status = "working".into();
            d.agent.connection_state = "connected".into();
        })
        .unwrap();
}

fn idle(ws: &Workspace, id: &str) {
    ws.store
        .update(id, "test/idle", &json!({}), |d| {
            for t in &mut d.turns {
                t["status"] = json!("completed");
            }
            d.agent.status = "idle".into();
        })
        .unwrap();
}

fn close(ws: &Workspace, id: &str, closed: bool) {
    ws.store.update(id, "test/closed", &json!({}), |d| d.agent.closed_at = closed.then(now)).unwrap();
}

/// A Workspace on disk next to the build (/tmp is memory here) with one
/// Project and Agents a, b and c in it, each running Turn t1.
pub(super) fn lab() -> (tempfile::TempDir, Arc<Workspace>, String) {
    let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
    std::fs::create_dir_all(parent).unwrap();
    let dir = tempfile::tempdir_in(parent).unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
    let project = ws.store.create_project("Code", BTreeMap::new()).unwrap().id;
    for id in ["a", "b", "c", "d"] {
        ws.store.insert(&agent(id)).unwrap();
        if id != "d" {
            ws.store.set_agent_project(id, Some(&project)).unwrap();
        }
        running(&ws, id, "t1");
    }
    (dir, ws, project)
}

fn body(text: &str) -> Value {
    json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["note"]},
        "note":{"type":"Markdown","props":{"text":text}}}})
}

fn put(key: &str, kind: &str) -> Value {
    let mut change = json!({"op":"put","key":key,"kind":kind,"title":format!("About {key}"),"body":body("Hello")});
    match kind {
        "ask" => change["ask"] = json!({"question":"Which way?","reply":{"options":[{"id":"left","label":"Left"},{"id":"right","label":"Right"}]}}),
        "status" => change["status"] = json!({"asOf":now(),"validFor":3600}),
        _ => {}
    }
    change
}

fn input(request: &str, version: i64, changes: Vec<Value>) -> Value {
    json!({"requestId":request,"expectedVersion":version,"changes":changes})
}

fn op(op: &str, key: &str) -> Value {
    json!({"op":op,"key":key})
}

async fn call(ws: &Arc<Workspace>, actor: &str, input: Value) -> Result<Result<Value, Value>> {
    update::update(ws, &FAKE, actor, input).await
}

async fn accept(ws: &Arc<Workspace>, actor: &str, input: Value) -> Value {
    let answer = call(ws, actor, input).await.unwrap();
    assert!(answer.is_ok(), "{answer:?}");
    answer.unwrap()
}

async fn reject(ws: &Arc<Workspace>, actor: &str, input: Value) -> Value {
    let answer = call(ws, actor, input).await.unwrap();
    assert!(answer.is_err(), "{answer:?}");
    answer.unwrap_err()
}

fn codes(rejected: &Value) -> Vec<String> {
    rejected["problems"].as_array().unwrap().iter().map(|p| p["code"].as_str().unwrap().to_owned()).collect()
}

fn version(ws: &Workspace, project: &str) -> i64 {
    sections::brief_version(&ws.store.db.read().unwrap(), project).unwrap()
}

fn brief(ws: &Workspace, actor: &str) -> Value {
    get(&ws.store, Some(actor), &json!({})).unwrap()
}

fn section<'a>(brief: &'a Value, key: &str) -> &'a Value {
    brief["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap_or(&Value::Null)
}

fn rows(ws: &Workspace, sql: &str) -> i64 {
    ws.store.db.read().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}

#[tokio::test]
async fn accepted_updates_and_no_change_each_leave_a_receipt_for_agent_project_and_turn() {
    let (_dir, ws, project) = lab();
    let first = accept(&ws, "a", input("r1", 0, vec![put("plan", "report")])).await;
    assert_eq!(first["version"], 1);
    assert_eq!(first["receipt"]["kind"], "updated");
    assert_eq!((first["receipt"]["agentId"].clone(), first["receipt"]["turnId"].clone()), (json!("a"), json!("t1")));
    assert_eq!(first["receipt"]["projectId"], project);
    assert_eq!(first["sections"], json!([{"key":"plan","version":1}]));
    // A retry gets its first answer; the same requestId with other content is refused.
    assert_eq!(accept(&ws, "a", input("r1", 0, vec![put("plan", "report")])).await, first);
    let conflict = call(&ws, "a", input("r1", 0, vec![put("other", "report")])).await.unwrap_err();
    assert!(conflict.to_string().starts_with("idempotency_conflict"), "{conflict}");
    let quiet = accept(&ws, "b", json!({"requestId":"q1","expectedVersion":1,"noChange":true})).await;
    assert_eq!((quiet["receipt"]["kind"].clone(), quiet["version"].clone(), quiet["sections"].clone()), (json!("noChange"), json!(1), json!([])));
    assert_eq!(turn_receipt(&ws.store, "a", "t1").unwrap().as_deref(), Some("updated"));
    assert_eq!(turn_receipt(&ws.store, "b", "t1").unwrap().as_deref(), Some("noChange"));
    assert_eq!(turn_receipt(&ws.store, "c", "t1").unwrap(), None);
    // An update in the Turn outweighs a later "no change".
    accept(&ws, "a", json!({"requestId":"q2","expectedVersion":1,"noChange":true})).await;
    assert_eq!(turn_receipt(&ws.store, "a", "t1").unwrap().as_deref(), Some("updated"));
    let both = reject(&ws, "a", json!({"requestId":"x","expectedVersion":1,"noChange":true,"changes":[put("p", "report")]})).await;
    assert_eq!(codes(&both), ["invalid_input"]);
    assert!(both["error"].as_str().unwrap().starts_with("brief_rejected: invalid_input"));
    assert_eq!(codes(&reject(&ws, "a", json!({"requestId":"y","expectedVersion":1})).await), ["empty_update"]);
    assert_eq!(codes(&reject(&ws, "a", json!({"requestId":"z","changes":[put("p", "report")]})).await), ["invalid_input"]);
    // The validator's problems come back under the change's path; nothing is kept.
    let mut invalid = put("bad", "report");
    invalid["title"] = json!("INVALID");
    let rejected = reject(&ws, "a", input("v", 1, vec![invalid])).await;
    assert_eq!((rejected["problems"][0]["code"].clone(), rejected["problems"][0]["path"].clone()), (json!("invalid_body"), json!("changes[0].body")));
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_receipts"), 3);
    assert_eq!(version(&ws, &project), 1);
}

#[tokio::test]
async fn without_a_reliable_turn_nothing_counts_and_an_old_receipt_never_counts_for_a_new_turn() {
    let (_dir, ws, project) = lab();
    idle(&ws, "a");
    assert_eq!(codes(&reject(&ws, "a", input("r1", 0, vec![put("plan", "report")])).await), ["no_active_turn"]);
    running(&ws, "a", "t2");
    ws.store.update("a", "test/disconnected", &json!({}), |d| d.agent.connection_state = "disconnected".into()).unwrap();
    assert_eq!(codes(&reject(&ws, "a", input("r1", 0, vec![put("plan", "report")])).await), ["no_active_turn"]);
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_receipts"), 0);
    running(&ws, "a", "t3");
    let first = accept(&ws, "a", input("r1", 0, vec![put("plan", "report")])).await;
    assert_eq!(first["receipt"]["turnId"], "t3");
    running(&ws, "a", "t4");
    // Replaying the earlier call answers as before, for t3; t4 still has none.
    assert_eq!(accept(&ws, "a", input("r1", 0, vec![put("plan", "report")])).await, first);
    assert_eq!(turn_receipt(&ws.store, "a", "t4").unwrap(), None);
    assert_eq!(turn_receipt(&ws.store, "a", "t3").unwrap().as_deref(), Some("updated"));
    // Only an Agent's own Project.
    assert_eq!(codes(&reject(&ws, "d", input("r", 0, vec![put("plan", "report")])).await), ["not_in_project"]);
    let other = ws.store.create_project("Research", BTreeMap::new()).unwrap().id;
    let elsewhere = json!({"requestId":"r9","projectId":other,"expectedVersion":0,"noChange":true});
    assert_eq!(codes(&reject(&ws, "a", elsewhere).await), ["not_in_project"]);
    assert_eq!(version(&ws, &project), 1);
}

#[tokio::test]
async fn a_stale_version_is_rejected_with_the_latest_brief_and_changes_nothing() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report")])).await;
    let rejected = reject(&ws, "b", input("b1", 0, vec![put("notes", "report")])).await;
    assert_eq!(codes(&rejected), ["version_conflict"]);
    assert_eq!(rejected["latest"]["version"], 1);
    assert_eq!(rejected["latest"]["sections"][0]["key"], "plan");
    assert_eq!(rejected["latest"]["sections"][0]["owner"], json!({"agentId":"a","name":"Agent a","state":"active"}));
    // So does a "no change" from a stale read.
    assert_eq!(codes(&reject(&ws, "c", json!({"requestId":"c1","expectedVersion":0,"noChange":true})).await), ["version_conflict"]);
    assert_eq!(version(&ws, &project), 1);
    assert_eq!(brief(&ws, "b")["sections"].as_array().unwrap().len(), 1);
    accept(&ws, "b", input("b2", 1, vec![put("notes", "report")])).await;
}

#[tokio::test]
async fn only_the_owner_changes_a_section_and_others_add_sub_topics() {
    let (_dir, ws, _project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("round-12", "report")])).await;
    let rejected = reject(&ws, "b", input("b1", 1, vec![put("round-12", "report")])).await;
    assert_eq!(codes(&rejected), ["not_owner"]);
    assert!(rejected["problems"][0]["reason"].as_str().unwrap().contains("round-12/your-part"));
    assert_eq!(rejected["problems"][0]["guide"], "brief_guide sections");
    accept(&ws, "b", input("b2", 1, vec![put("round-12/review", "report")])).await;
    let read = brief(&ws, "b");
    assert_eq!(read["version"], 2);
    assert_eq!(section(&read, "round-12")["owner"]["agentId"], "a");
    assert_eq!(section(&read, "round-12/review")["owner"]["agentId"], "b");
    assert_eq!(read["you"], json!({"agentId":"b","ownsKeys":["round-12/review"],"openAsks":0,"repliedAsks":[],"staleStatus":[],
        "capabilities":{"editContent":true,"requiresTurnUpdate":false,"writeOwnAsk":true},"homeHint":outcome_hint()}));
    for change in [op("remove", "round-12"), op("claim", "round-12")] {
        let codes = codes(&reject(&ws, "b", input("b3", 2, vec![change])).await);
        assert!(codes == ["not_owner"] || codes == ["not_orphan"], "{codes:?}");
    }
    assert_eq!(codes(&reject(&ws, "b", input("b4", 2, vec![op("remove", "nothing")])).await), ["not_found"]);
    assert_eq!(codes(&reject(&ws, "b", input("b5", 2, vec![op("remove", "Bad Key")])).await), ["invalid_key"]);
    assert_eq!(codes(&reject(&ws, "b", input("b6", 2, vec![put("x", "report"), put("x", "status")])).await), ["duplicate_key"]);
    let removed = accept(&ws, "b", input("b7", 2, vec![op("remove", "round-12/review")])).await;
    assert_eq!(removed["sections"], json!([{"key":"round-12/review","version":1}]));
    assert!(section(&brief(&ws, "b"), "round-12/review").is_null());
}

#[tokio::test]
async fn a_closed_or_deleted_owners_sections_are_claimed_once_within_the_project() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report"), put("decide", "ask")])).await;
    close(&ws, "a", true);
    let read = brief(&ws, "b");
    assert_eq!(section(&read, "plan")["owner"]["state"], "closed");
    let rejected = reject(&ws, "b", input("b1", 1, vec![put("plan", "report")])).await;
    assert_eq!(codes(&rejected), ["not_owner"]);
    assert!(rejected["problems"][0]["reason"].as_str().unwrap().contains("claim"));
    // Claiming a section and changing it are two updates.
    let both = reject(&ws, "b", input("b1b", 1, vec![op("claim", "plan"), put("plan", "report")])).await;
    assert_eq!(codes(&both), ["duplicate_key"]);
    assert!(both["problems"][0]["reason"].as_str().unwrap().contains("send the claim alone"), "{both}");
    // Two claims at once: one wins, the other is refused, nobody else owns it.
    let (b, c) = tokio::join!(call(&ws, "b", input("b2", 1, vec![op("claim", "plan")])), call(&ws, "c", input("c2", 1, vec![op("claim", "plan")])));
    let (b, c) = (b.unwrap(), c.unwrap());
    assert_eq!([b.is_ok(), c.is_ok()].iter().filter(|ok| **ok).count(), 1, "{b:?} {c:?}");
    let (winner, loser) = if b.is_ok() { ("b", "c") } else { ("c", "b") };
    let read = brief(&ws, winner);
    assert_eq!(section(&read, "plan")["owner"], json!({"agentId":winner,"name":format!("Agent {winner}"),"state":"active"}));
    assert_eq!(section(&read, "plan")["version"], 1, "a claim does not change the content");
    assert_eq!(codes(&reject(&ws, loser, input("again", 2, vec![op("claim", "plan")])).await), ["not_orphan"]);
    accept(&ws, winner, input("w1", 2, vec![put("plan", "report")])).await;
    // The old owner, reopened, no longer owns it; its unclaimed ask is still its own.
    close(&ws, "a", false);
    assert_eq!(codes(&reject(&ws, "a", input("a2", 3, vec![put("plan", "report")])).await), ["not_owner"]);
    assert_eq!(codes(&reject(&ws, loser, input("l1", 3, vec![op("claim", "decide")])).await), ["not_orphan"]);
    // A deleted owner's section stays, under its last name, until claimed.
    accept(&ws, "c", input("c3", 3, vec![put("c-notes", "status")])).await;
    record_turn_outcome(&ws.store, "c", "t1", &project, "missing").unwrap();
    close(&ws, "c", true);
    ws.store.delete_closed_agent("c").unwrap();
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_turns WHERE agent_id='c'"), 0);
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_receipts WHERE agent_id='c'"), 0);
    let read = brief(&ws, "b");
    assert_eq!(section(&read, "c-notes")["owner"], json!({"agentId":"c","name":"Agent c","state":"deleted"}));
    accept(&ws, "b", input("b9", 4, vec![op("claim", "c-notes")])).await;
    assert_eq!(section(&brief(&ws, "b"), "c-notes")["owner"]["agentId"], "b");
}

#[tokio::test]
async fn topic_sub_topic_ask_and_attachment_limits_are_rejected_with_their_codes() {
    let (_dir, ws, _project) = lab();
    let topics: Vec<Value> = (0..12).map(|n| put(&format!("t{n}"), "report")).collect();
    accept(&ws, "a", input("a1", 0, topics)).await;
    let rejected = reject(&ws, "a", input("a2", 1, vec![put("t12", "report")])).await;
    assert_eq!((codes(&rejected), rejected["problems"][0]["guide"].clone()), (vec!["topic_limit".to_owned()], json!("brief_guide limits")));
    let subs: Vec<Value> = (1..=4).map(|n| put(&format!("t0/s{n}"), "report")).collect();
    accept(&ws, "a", input("a3", 1, subs)).await;
    assert_eq!(codes(&reject(&ws, "a", input("a4", 2, vec![put("t0/s5", "report")])).await), ["topic_limit"]);
    let asks: Vec<Value> = (1..=3).map(|n| put(&format!("t1/q{n}"), "ask")).collect();
    accept(&ws, "a", input("a5", 2, asks)).await;
    assert_eq!(codes(&reject(&ws, "a", input("a6", 3, vec![put("t1/q4", "ask")])).await), ["ask_limit"]);
    assert_eq!(brief(&ws, "a")["you"]["openAsks"], 3);
    // Another Agent has its own three.
    accept(&ws, "b", input("b1", 3, vec![put("t2/q1", "ask")])).await;
    // An ask the Agent claims counts too.
    close(&ws, "b", true);
    assert_eq!(codes(&reject(&ws, "a", input("a7", 4, vec![op("claim", "t2/q1")])).await), ["ask_limit"]);
    let mut many = put("t3", "report");
    many["attachments"] = json!((0..13).map(|n| json!({"name":format!("f{n}.txt"),"url":"https://example.com"})).collect::<Vec<_>>());
    assert_eq!(codes(&reject(&ws, "a", input("a8", 4, vec![many])).await), ["attachment_limit"]);
    let changes: Vec<Value> = (0..25).map(|n| put(&format!("t4/x{n}"), "report")).collect();
    assert!(codes(&reject(&ws, "a", input("a9", 4, changes)).await).contains(&"invalid_input".to_owned()));
}

#[tokio::test]
async fn a_replied_ask_waits_for_its_owner_and_a_new_version_asks_again() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("decide", "ask")])).await;
    let ask = |ws: &Workspace| section(&brief(ws, "a"), "decide")["ask"].clone();
    assert_eq!(ask(&ws)["state"], "open");
    let needs = |ws: &Workspace| home::build(&ws.store).unwrap()["needsYou"].as_array().unwrap().iter()
        .filter(|n| n["kind"] == "ask").map(|n| n["sectionKey"].clone()).collect::<Vec<_>>();
    assert_eq!(needs(&ws), [json!("decide")]);
    assert!(sections::mark_replied(&ws.store, &project, "decide", "Left: go").unwrap());
    let replied = ask(&ws);
    assert_eq!((replied["state"].clone(), replied["replyText"].clone()), (json!("replied"), json!("Left: go")));
    assert!(replied["repliedAt"].is_string());
    assert!(needs(&ws).is_empty(), "a replied ask waits for its owner, not the user");
    // Another section's update leaves it replied.
    accept(&ws, "a", input("a2", 1, vec![put("notes", "report")])).await;
    assert_eq!(ask(&ws)["state"], "replied");
    // The owner's new version is its next question: open again, for the user.
    accept(&ws, "a", input("a2b", 2, vec![put("decide", "ask")])).await;
    let again = ask(&ws);
    assert_eq!(again["state"], "open");
    assert!(again["replyText"].is_null() && again["repliedAt"].is_null(), "{again}");
    assert_eq!(needs(&ws), [json!("decide")]);
    assert!(sections::mark_replied(&ws.store, &project, "decide", "Right").unwrap());
    // It cannot slip away as another kind.
    assert_eq!(codes(&reject(&ws, "a", input("a3", 3, vec![put("decide", "report")])).await), ["ask_unresolved"]);
    assert_eq!(codes(&reject(&ws, "a", input("a4", 3, vec![op("remove", "decide")])).await), ["ask_unresolved"]);
    assert_eq!(codes(&reject(&ws, "b", input("b1", 3, vec![op("resolve", "decide")])).await), ["not_owner"]);
    let resolved = accept(&ws, "a", input("a5", 3, vec![op("resolve", "decide")])).await;
    assert_eq!(resolved["sections"], json!([{"key":"decide","version":3}]));
    assert!(section(&brief(&ws, "a"), "decide").is_null());
    let panel = &home::build(&ws.store).unwrap()["projects"][0];
    assert_eq!(panel["brief"]["history"][0]["ask"]["state"], "resolved");
    assert_eq!(panel["brief"]["history"][0]["history"], true);
    assert!(!sections::mark_replied(&ws.store, &project, "decide", "late").unwrap());
    assert_eq!(codes(&reject(&ws, "a", input("a6", 4, vec![op("resolve", "decide")])).await), ["not_found"]);
}

#[tokio::test]
async fn brief_get_lists_your_own_replied_asks_until_you_resolve_them() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("release", "ask"), put("budget", "ask")])).await;
    accept(&ws, "b", input("b1", 1, vec![put("other", "ask")])).await;
    let you = |ws: &Workspace, actor: &str| brief(ws, actor)["you"].clone();
    let keys = |you: &Value| you["repliedAsks"].as_array().unwrap().iter().map(|e| e["key"].clone()).collect::<Vec<_>>();
    // Open asks are the user's to answer: nothing for their owners to act on yet.
    assert_eq!((you(&ws, "a")["repliedAsks"].clone(), you(&ws, "a")["openAsks"].clone()), (json!([]), json!(2)));
    let long = "x".repeat(400);
    assert!(sections::mark_replied(&ws.store, &project, "release", &format!("Left: {long}")).unwrap());
    assert!(sections::mark_replied(&ws.store, &project, "other", "Right").unwrap());
    let entry = you(&ws, "a")["repliedAsks"].clone();
    assert_eq!(keys(&you(&ws, "a")), [json!("release")], "{entry}");
    let entry = &entry[0];
    assert_eq!((entry["title"].clone(), entry["updatedSinceReply"].clone()), (json!("About release"), json!(false)));
    assert_eq!(entry["repliedAt"], section(&brief(&ws, "a"), "release")["ask"]["repliedAt"]);
    // In short: the section beside it carries the whole reply.
    let reply = entry["reply"].as_str().unwrap();
    assert_eq!(reply.chars().count(), 301, "{reply}");
    assert!(reply.starts_with("Left: x") && reply.ends_with('…'), "{reply}");
    assert_eq!(section(&brief(&ws, "a"), "release")["ask"]["replyText"], json!(format!("Left: {long}")));
    // Only the caller's own; a replied ask still counts as unresolved.
    assert_eq!(keys(&you(&ws, "b")), [json!("other")]);
    assert_eq!(you(&ws, "a")["openAsks"], 2);
    // A second reply is the same entry with the latest answer.
    assert!(sections::mark_replied(&ws.store, &project, "release", "Right").unwrap());
    assert_eq!((keys(&you(&ws, "a")), you(&ws, "a")["repliedAsks"][0]["reply"].clone()), (vec![json!("release")], json!("Right")));
    // Progress after the reply (an edit) keeps it replied and says so.
    accept(&ws, "a", input("a2", 2, vec![edit("release", json!({"note":markdown("Started; waiting for CI.")}))])).await;
    let entry = you(&ws, "a")["repliedAsks"][0].clone();
    assert_eq!((entry["key"].clone(), entry["updatedSinceReply"].clone()), (json!("release"), json!(true)));
    assert_eq!(section(&brief(&ws, "a"), "release")["ask"]["state"], "replied");
    // Resolving it ends it.
    accept(&ws, "a", input("a3", 3, vec![op("resolve", "release")])).await;
    assert_eq!((you(&ws, "a")["repliedAsks"].clone(), you(&ws, "a")["openAsks"].clone()), (json!([]), json!(1)));
    // An Ask-only member reads and resolves its own the same way.
    editors::save(&ws.store, &project, 0, Some(vec!["a".into()])).unwrap();
    let only = you(&ws, "b");
    assert_eq!((only["capabilities"]["editContent"].clone(), keys(&only)), (json!(false), vec![json!("other")]));
    accept(&ws, "b", input("b2", 4, vec![op("resolve", "other")])).await;
    assert_eq!(you(&ws, "b")["repliedAsks"], json!([]));
}

#[tokio::test]
async fn a_deferred_ask_leaves_needs_you_until_its_time() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("decide", "ask"), put("plan", "report")])).await;
    // Home's Needs you, and the Asks push notifications compare (T-200): the same.
    let asks = |ws: &Workspace| {
        let shown = home::build(&ws.store).unwrap()["needsYou"].as_array().unwrap().iter().filter(|n| n["kind"] == "ask").count();
        let pushed = open_asks(&ws.store).unwrap();
        assert_eq!(pushed.len(), shown);
        assert!(pushed.iter().all(|ask| ask.project == project && ask.key == "decide" && ask.owner_id == "a" && ask.owner_name == "Agent a"));
        shown
    };
    assert_eq!(asks(&ws), 1);
    let later = (chrono::Utc::now() + chrono::Duration::hours(1)).to_rfc3339();
    sections::defer(&ws.store, &project, "decide", Some(&later)).unwrap();
    assert_eq!(asks(&ws), 0);
    assert!(section(&brief(&ws, "a"), "decide")["ask"]["deferredUntil"].is_string());
    sections::defer(&ws.store, &project, "decide", Some("2020-01-01T00:00:00Z")).unwrap();
    assert_eq!(asks(&ws), 1);
    sections::defer(&ws.store, &project, "decide", None).unwrap();
    assert_eq!(asks(&ws), 1);
    assert!(sections::defer(&ws.store, &project, "plan", None).unwrap_err().to_string().starts_with("not_ask"));
    assert!(sections::defer(&ws.store, &project, "decide", Some("tomorrow")).is_err());
}

#[tokio::test]
async fn seen_records_only_the_version_shown_and_a_seen_report_moves_to_history() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("result", "report"), put("load", "status")])).await;
    accept(&ws, "a", input("a2", 1, vec![put("result", "report")])).await;
    // The user saw version 1 while version 2 existed: it stays unseen.
    let marked = sections::mark_seen(&ws.store, &project, &[("result".into(), 1)]).unwrap();
    assert_eq!((marked["unseen"].clone(), marked["archived"].clone()), (json!(2), json!([])));
    assert_eq!(section(&brief(&ws, "a"), "result")["seen"]["version"], 1);
    // A version beyond what exists is recorded as what exists; the report goes.
    let marked = sections::mark_seen(&ws.store, &project, &[("result".into(), 9), ("load".into(), 1), ("gone".into(), 1)]).unwrap();
    assert_eq!(marked["seen"], json!([{"key":"result","version":2},{"key":"load","version":1}]));
    assert_eq!((marked["unseen"].clone(), marked["archived"].clone()), (json!(0), json!(["result"])));
    let panel = &home::build(&ws.store).unwrap()["projects"][0];
    assert_eq!(panel["unseen"], 0);
    assert_eq!(panel["brief"]["sections"].as_array().unwrap().len(), 1, "a status stays");
    assert_eq!(panel["brief"]["history"][0]["key"], "result");
    assert_eq!(panel["brief"]["history"][0]["seen"]["version"], 2);
    // Written again, it is newer than anything seen.
    let again = accept(&ws, "a", input("a3", 2, vec![put("result", "report")])).await;
    assert_eq!(again["sections"], json!([{"key":"result","version":3}]));
    assert_eq!(home::build(&ws.store).unwrap()["projects"][0]["unseen"], 1);
    // Marks never change versions.
    assert_eq!(version(&ws, &project), 3);
}

#[tokio::test]
async fn attachments_are_snapshots_on_the_core_host_and_references_otherwise() {
    let (dir, ws, project) = lab();
    let files = dir.path().join("files");
    std::fs::create_dir_all(files.join("folder")).unwrap();
    std::fs::write(files.join("loss.csv"), "step,loss\n1,0.5\n").unwrap();
    let big = std::fs::File::create(files.join("weights.bin")).unwrap();
    big.set_len(SNAPSHOT_FILE_BYTES + 1).unwrap();
    let path = |name: &str| files.join(name).to_string_lossy().into_owned();
    let mut change = put("run", "report");
    change["attachments"] = json!([
        {"name":"loss.csv","path":path("loss.csv"),"caption":"Loss"},
        {"name":"weights.bin","path":path("weights.bin")},
        {"name":"folder","path":path("folder")},
        {"name":"missing.log","path":path("missing.log")},
        {"name":"paper","url":"https://example.com/paper"},
    ]);
    accept(&ws, "a", input("a1", 0, vec![change])).await;
    let shown = section(&brief(&ws, "a"), "run")["attachments"].clone();
    let snapshot = &shown[0];
    assert_eq!(
        (snapshot["kind"].clone(), snapshot["mime"].clone(), snapshot["size"].clone(), snapshot["snapshot"].clone(), snapshot["mayChange"].clone()),
        (json!("data"), json!("text/csv"), json!(16), json!(true), json!(false))
    );
    assert!(snapshot.get("path").is_none() && snapshot.get("sha256").is_none(), "{snapshot}");
    assert_eq!(snapshot["caption"], "Loss");
    let large = &shown[1];
    assert_eq!((large["snapshot"].clone(), large["mayChange"].clone(), large["size"].clone()), (json!(false), json!(true), json!(SNAPSHOT_FILE_BYTES + 1)));
    assert_eq!(large["path"], path("weights.bin"));
    for reference in [&shown[2], &shown[3]] {
        assert_eq!((reference["snapshot"].clone(), reference["mayChange"].clone()), (json!(false), json!(true)), "{reference}");
    }
    assert_eq!((shown[4]["kind"].clone(), shown[4]["url"].clone()), (json!("link"), json!("https://example.com/paper")));
    // The snapshot is kept by content, and served as it was when written.
    std::fs::write(files.join("loss.csv"), "step,loss\n1,0.9\n").unwrap();
    let cache = attachments::dir(&ws.data_dir);
    let (file, mime) = attachments::snapshot_file(&ws.store, &cache, &project, "run", "loss.csv", None).unwrap().ok().unwrap();
    assert_eq!((std::fs::read_to_string(file).unwrap(), mime), ("step,loss\n1,0.5\n".to_owned(), "text/csv".to_owned()));
    let reference = attachments::snapshot_file(&ws.store, &cache, &project, "run", "weights.bin", None).unwrap().err().unwrap();
    assert_eq!(reference.code, "not_snapshot");
    // Yuzuno's own data is never attached; a path must be absolute.
    let mut own = put("own", "report");
    own["attachments"] = json!([{"name":"db","path":ws.data_dir.join("workspace.sqlite")},{"name":"rel","path":"notes.txt"}]);
    let rejected = reject(&ws, "a", input("a2", 1, vec![own])).await;
    assert_eq!(codes(&rejected), ["attachment_path", "attachment_path"]);
    assert_eq!(rejected["problems"][0]["path"], "changes[0].attachments[0].path");
    // A remote Agent's files are only referenced.
    ws.store.update("b", "test/remote", &json!({}), |d| {
        d.agent.remote = Some(serde_json::from_value(json!({"machine":{"id":"m","name":"lab_host","target":"lab_host","codex":"codex","defaultCwd":"/"},"runtime":null})).unwrap());
    }).unwrap();
    let mut remote = put("remote", "report");
    remote["attachments"] = json!([{"name":"loss.csv","path":path("loss.csv")}]);
    accept(&ws, "b", input("b1", 1, vec![remote])).await;
    assert_eq!(section(&brief(&ws, "b"), "remote")["attachments"][0]["snapshot"], false);
    assert_eq!(std::fs::read_dir(&cache).unwrap().count(), 1);
}

fn attach(file: &std::path::Path) -> Value {
    json!([{"name":file.file_name().unwrap().to_string_lossy(),"path":file}])
}

#[tokio::test]
async fn pruning_and_clearing_never_remove_a_snapshot_a_live_section_shows() {
    let (dir, ws, project) = lab();
    let file = |name: &str, bytes: usize| {
        let path = dir.path().join(name);
        std::fs::write(&path, "x".repeat(bytes) + name).unwrap();
        path
    };
    let (one, two, three) = (file("one.txt", 10), file("two.txt", 20), file("three.txt", 40));
    let mut changes = vec![];
    for (key, path) in [("one", &one), ("two", &two), ("three", &three)] {
        let mut change = put(key, "report");
        change["attachments"] = attach(path);
        changes.push(change);
    }
    // "copy" shows the same bytes as "two".
    let mut copy = put("copy", "report");
    copy["attachments"] = attach(&two);
    changes.push(copy);
    accept(&ws, "a", input("a1", 0, changes)).await;
    sections::mark_seen(&ws.store, &project, &[("one".into(), 1), ("copy".into(), 1)]).unwrap();
    let cache = attachments::dir(&ws.data_dir);
    let files = || std::fs::read_dir(&cache).unwrap().count();
    assert_eq!(files(), 3);
    let total = |ws: &Workspace| attachments::snapshot_bytes(&ws.store.db.read().unwrap(), &project).unwrap();
    // one.txt, two.txt (shown twice, counted once) and three.txt.
    assert_eq!(total(&ws), 17 + 27 + 49);
    let prune = |cap: u64| {
        let mut writer = ws.store.db.write().unwrap();
        let tx = writer.transaction().unwrap();
        let within = attachments::prune(&tx, &project, cap).unwrap();
        tx.commit().unwrap();
        within
    };
    // Oldest history first: "one" (then "copy", whose bytes "two" still shows).
    assert!(prune(total(&ws) - 1));
    let history = &home::build(&ws.store).unwrap()["projects"][0]["brief"]["history"];
    let kept: Vec<(Value, Value)> = history.as_array().unwrap().iter().map(|s| (s["key"].clone(), s["attachments"][0]["snapshot"].clone())).collect();
    assert!(kept.contains(&(json!("one"), json!(false))) && kept.contains(&(json!("copy"), json!(true))), "{kept:?}");
    // The live sections alone are over this: nothing they show is released.
    assert!(!prune(10));
    assert_eq!(total(&ws), 27 + 49);
    let live = &home::build(&ws.store).unwrap()["projects"][0]["brief"]["sections"];
    assert!(live.as_array().unwrap().iter().all(|s| s["attachments"][0]["snapshot"] == true));
    attachments::collect_garbage(&ws.store, &cache).unwrap();
    assert_eq!(files(), 2, "one's file goes; two's stays though history no longer keeps it");
    let cleared = attachments::clear(&ws.store, &cache).unwrap();
    assert_eq!(cleared["removedFiles"], 0);
    assert_eq!(files(), 2);
    let (two_file, _) = attachments::snapshot_file(&ws.store, &cache, &project, "two", "two.txt", None).unwrap().ok().unwrap();
    assert!(two_file.is_file());
}

#[tokio::test]
async fn charts_read_snapshot_data_downsampled_per_series() {
    let (dir, ws, project) = lab();
    let mut csv = String::from("step,loss,\"acc, %\"\n");
    for step in 0..20_000 {
        csv.push_str(&format!("{step},{},{}\n", 1.0 / (step as f64 + 1.0), if step % 2 == 0 { "0.5".to_owned() } else { String::new() }));
    }
    let log = dir.path().join("log.csv");
    std::fs::write(&log, csv).unwrap();
    let rows = dir.path().join("rows.jsonl");
    std::fs::write(&rows, (0..100).map(|n| json!({"name":format!("run-{n}"),"score":n}).to_string() + "\n").collect::<String>()).unwrap();
    let chart = |kind: &str, attachment: &str, x: &str, series: Value| json!({"type":kind,"props":{"id":"c","title":"Chart",
        "x":{"label":"X"},"y":{"label":"Y"},"data":{"attachment":attachment,"x":x,"series":series}}});
    let mut change = put("curves", "report");
    change["body"] = json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["curve","bars","scatter"]},
        "curve":chart("LineChart", "log.csv", "step", json!([{"name":"loss","column":"loss"},{"name":"acc","column":"acc, %"}])),
        "bars":chart("BarChart", "rows.jsonl", "name", json!([{"name":"score","column":"score"}])),
        "scatter":chart("ScatterChart", "rows.jsonl", "name", json!([{"name":"score","column":"score"}]))}});
    change["attachments"] = json!([{"name":"log.csv","path":log},{"name":"rows.jsonl","path":rows},{"name":"paper","url":"https://example.com"}]);
    accept(&ws, "a", input("a1", 0, vec![change])).await;
    let cache = attachments::dir(&ws.data_dir);
    let read = |element: &str| attachments::chart(&ws.store, &cache, &project, "curves", element, None).unwrap();
    let curve = read("curve").ok().unwrap();
    assert_eq!((curve["downsampled"].clone(), curve["sourcePoints"].clone()), (json!(true), json!(30_000)));
    let loss = curve["series"][0]["points"].as_array().unwrap();
    assert_eq!(loss.len(), attachments::CHART_POINTS);
    assert_eq!((loss[0].clone(), loss.last().unwrap()[0].clone()), (json!([0.0, 1.0]), json!(19_999.0)));
    // Rows without a number are left out, not drawn as zero.
    assert_eq!(curve["series"][1]["points"].as_array().unwrap().len(), attachments::CHART_POINTS);
    assert_eq!((curve["x"].clone(), curve["series"][1]["name"].clone()), (json!({"label":"X"}), json!("acc")));
    let bars = read("bars").ok().unwrap();
    assert_eq!((bars["downsampled"].clone(), bars["series"][0]["points"][3].clone()), (json!(false), json!(["run-3", 3.0])));
    assert_eq!(read("scatter").ok().unwrap()["sourcePoints"], 0, "a scatter needs numeric x");
    assert_eq!(read("body").err().unwrap().code, "element_not_found");
    assert_eq!(read("nothing").err().unwrap().code, "element_not_found");
    let missing = attachments::chart(&ws.store, &cache, &project, "other", "curve", None).unwrap().err().unwrap();
    assert_eq!(missing.code, "section_not_found");
}

#[test]
fn downsampling_keeps_the_ends_and_the_shape() {
    let points: Vec<(f64, f64)> = (0..10_000).map(|x| (x as f64, if x == 4321 { 100.0 } else { (x as f64 / 100.0).sin() })).collect();
    let kept = attachments::lttb(&points, 500);
    assert_eq!(kept.len(), 500);
    assert_eq!((kept[0], *kept.last().unwrap()), (0, 9_999));
    assert!(kept.windows(2).all(|pair| pair[0] < pair[1]));
    assert!(kept.contains(&4321), "a spike survives");
    assert_eq!(attachments::lttb(&points[..10], 500), (0..10).collect::<Vec<_>>());
}

#[tokio::test]
async fn home_orders_projects_and_needs_you_by_priority_then_wait() {
    let (_dir, ws, first) = lab();
    let second = ws.store.create_project("Research", BTreeMap::new()).unwrap().id;
    ws.store.insert(&agent("e")).unwrap();
    ws.store.set_agent_project("e", Some(&second)).unwrap();
    running(&ws, "e", "t1");
    accept(&ws, "a", input("a1", 0, vec![put("decide", "ask"), put("plan", "report")])).await;
    accept(&ws, "e", input("e1", 0, vec![put("pick", "ask")])).await;
    ws.store.update("b", "test/pending", &json!({}), |d| {
        d.pending.push(serde_json::from_value(json!({"id":"req-1","agentId":"b","method":"item/commandExecution/requestApproval",
            "params":{"command":"rm -rf build","turnId":"t1"},"createdAt":"2026-01-01T00:00:00Z"})).unwrap());
        d.agent.error = Some("Rate limited".into());
    }).unwrap();
    record_turn_outcome(&ws.store, "c", "t0", &first, "remindFailed").unwrap();
    record_turn_outcome(&ws.store, "c", "t1", &first, "updated").unwrap();
    // A live Job filed under the second Project's task, though its Agent is in the first.
    let task = ws.store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Train","projectId":second})).unwrap();
    let task_id: String = ws.store.db.read().unwrap().query_row("SELECT id FROM collaboration_tasks", [], |r| r.get(0)).unwrap();
    ws.store.db.write().unwrap().execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES('job-1',?1,'a','queued',?2)",
        rusqlite::params![task_id, json!({"name":"train","agent":{"name":"Agent a"},"taskRef":task["task"]["id"]}).to_string()]).unwrap();
    let view = home::build(&ws.store).unwrap();
    assert_eq!(view["order"], json!([first, second]));
    let needs: Vec<(Value, Value)> = view["needsYou"].as_array().unwrap().iter().map(|n| (n["kind"].clone(), n["projectId"].clone())).collect();
    assert_eq!(needs, [(json!("approval"), json!(first)), (json!("ask"), json!(first)), (json!("ask"), json!(second))]);
    assert_eq!(view["needsYou"][0]["title"], "rm -rf build");
    let panel = &view["projects"][0];
    assert_eq!(panel["project"]["id"], first);
    assert_eq!(panel["agents"], json!({"working":3,"idle":0,"waiting":0,"error":0,"offline":0,"total":3}));
    assert_eq!(panel["errors"][0]["message"], "Rate limited");
    assert_eq!((panel["pending"][0]["id"].clone(), panel["pending"][0]["agentName"].clone()), (json!("req-1"), json!("Agent b")));
    assert_eq!(panel["missing"], json!([{"agentId":"c","agentName":"Agent c","turnId":"t0","at":panel["missing"][0]["at"],"outcome":"remindFailed"}]));
    assert_eq!(panel["unseen"], 2);
    assert_eq!(panel["jobs"], json!([]));
    assert_eq!(view["projects"][1]["jobs"][0]["name"], "train");
    assert_eq!(view["projects"][1]["jobs"][0]["agentName"], "Agent a");
    // The user's order puts the second Project first, panels and strip alike.
    assert_eq!(home::set_order(&ws.store, &[second.clone()]).unwrap(), [second.clone(), first.clone()]);
    let view = home::build(&ws.store).unwrap();
    assert_eq!(view["projects"][0]["project"]["id"], second);
    assert_eq!(view["needsYou"][0]["projectId"], second);
    assert!(home::set_order(&ws.store, &["nope".into()]).is_err());
    assert!(home::set_order(&ws.store, &[first.clone(), first.clone()]).is_err());
    // An archived Project leaves Home and needs no Brief.
    ws.store.update_project(&second, crate::projects::ProjectChange { name: None, default_dirs: BTreeMap::new(), archived: Some(true) }).unwrap();
    assert_eq!(home::build(&ws.store).unwrap()["order"], json!([first]));
    assert_eq!(agent_edits_brief(&ws.store, "e").unwrap(), None);
}

/// Home lists an Agent's waiting requests as its record has them, held or
/// not, without reading the whole record (T-120): it is rebuilt on every
/// change while one waits.
#[tokio::test]
async fn home_lists_waiting_requests_without_reading_whole_records() {
    let (_dir, ws, project) = lab();
    ws.store.update("b", "test/pending", &json!({}), |d| {
        d.pending.push(serde_json::from_value(json!({"id":"req-1","agentId":"b","method":"item/commandExecution/requestApproval",
            "params":{"command":"rm -rf build","turnId":"t1"},"createdAt":"2026-01-01T00:00:00Z"})).unwrap());
    }).unwrap();
    let listed = |ws: &Workspace| {
        let reads = crate::store::DETAIL_READS.with(|n| n.get());
        let view = home::build(&ws.store).unwrap();
        assert_eq!(crate::store::DETAIL_READS.with(|n| n.get()), reads, "Home read a whole record");
        assert_eq!(view["projects"][0]["project"]["id"], project);
        assert_eq!(view["needsYou"][0]["requestId"], "req-1");
        let mut requests = view["projects"][0]["pending"].clone();
        for request in requests.as_array_mut().unwrap() {
            assert_eq!(request.as_object_mut().unwrap().remove("agentName"), Some(json!("Agent b")));
        }
        requests
    };
    // Held, as a record is after every commit.
    let held = listed(&ws);
    assert_eq!(held, serde_json::to_value(ws.store.detail("b").unwrap().pending).unwrap());
    // Released, as a record idle since it was written is.
    assert!(ws.store.release_for_test("b"), "the record was held");
    assert_eq!(listed(&ws), held);
    assert!(!ws.store.release_for_test("b"), "listing held it again");
    assert_eq!(held[0]["params"]["command"], "rm -rf build");
}

#[tokio::test]
async fn live_references_show_core_state_or_not_found() {
    let (_dir, ws, project) = lab();
    let task = ws.store.collaboration_call(None, "task_create", json!({"requestId":"t","title":"Ship it","status":"doing"})).unwrap();
    let id = task["task"]["id"].as_str().unwrap().to_owned();
    let mut change = put("refs", "report");
    change["body"] = json!({"root":"body","elements":{"body":{"type":"BriefBody","props":{},"children":["refs"]},
        "refs":{"type":"LiveRefs","props":{"items":[{"kind":"task","id":id},{"kind":"agent","id":"b"},
            {"kind":"job","id":"nope"},{"kind":"machine","id":"local"}]}}}});
    accept(&ws, "a", input("a1", 0, vec![change])).await;
    let refs = section(&brief(&ws, "a"), "refs")["refs"].clone();
    assert_eq!(refs[format!("task:{id}")], json!({"kind":"task","id":id,"found":true,"title":"Ship it","state":"doing","tone":"active"}));
    assert_eq!(refs["agent:b"]["state"], "working");
    assert_eq!(refs["job:nope"], json!({"kind":"job","id":"nope","found":false}));
    assert_eq!(refs["machine:local"]["title"], "Core host");
    let home = home::build(&ws.store).unwrap();
    assert_eq!(home["projects"][0]["brief"]["sections"][0]["refs"]["agent:b"]["title"], "Agent b");
    let _ = project;
}

#[tokio::test]
async fn turn_outcomes_are_final_except_reminded_and_follow_project_membership() {
    let (_dir, ws, project) = lab();
    assert_eq!(agent_edits_brief(&ws.store, "a").unwrap(), Some(project.clone()));
    assert_eq!(agent_edits_brief(&ws.store, "d").unwrap(), None);
    assert!(record_turn_outcome(&ws.store, "a", "t9", &project, "reminded").unwrap());
    assert_eq!(turn_outcome(&ws.store, "a", "t9").unwrap(), Some(("reminded".into(), 1)));
    assert!(record_turn_outcome(&ws.store, "a", "t9", &project, "reminded").unwrap());
    assert!(record_turn_outcome(&ws.store, "a", "t9", &project, "updated").unwrap());
    assert_eq!(turn_outcome(&ws.store, "a", "t9").unwrap(), Some(("updated".into(), 2)));
    assert!(!record_turn_outcome(&ws.store, "a", "t9", &project, "missing").unwrap());
    assert_eq!(turn_outcome(&ws.store, "a", "t9").unwrap(), Some(("updated".into(), 2)));
    assert!(record_turn_outcome(&ws.store, "a", "t9", &project, "sideways").is_err());
    assert_eq!(turn_outcome(&ws.store, "a", "nope").unwrap(), None);
}

#[tokio::test]
async fn a_reply_quotes_its_section_joins_the_running_turn_and_marks_the_ask_only_when_sent() {
    let (_dir, ws, project) = lab();
    let mut ask = put("decide", "ask");
    ask["ask"]["reply"]["choice"] = json!({"a":{"id":"fast","label":"Fast path"},"b":{"id":"safe","label":"Safe path"}});
    accept(&ws, "a", input("a1", 0, vec![ask])).await;
    let row = sections::live_key(&ws.store.db.read().unwrap(), &project, "decide").unwrap().unwrap();
    assert_eq!(home::choice(&row, "right"), Some(("right".into(), "Right".into())));
    assert_eq!(home::choice(&row, "safe"), Some(("safe".into(), "Safe path".into())));
    assert_eq!(home::choice(&row, "up"), None);
    let message = home::compose("Code", Some(&row), home::choice(&row, "left").as_ref(), "Because it is shorter");
    assert!(message.contains("`decide`") && message.contains("> Which way?") && message.contains("Chose: Left (left)"), "{message}");
    assert!(message.contains("Because it is shorter") && message.contains("resolve it with brief_update"));
    // How the owner closes it: when, and what the reply never authorizes.
    assert!(message.contains(r#"{op:"resolve", key:"decide"}"#) && message.contains("only after that action is done"), "{message}");
    assert!(message.contains("keep the ask replied") && message.contains("infer no retry, merge or wider permission that it does not grant"), "{message}");
    assert!(home::compose("Code", None, None, " Hi ").ends_with("Code:\n\nHi"));
    // A pick that also sends its label as text says it once.
    let picked = home::compose("Code", Some(&row), home::choice(&row, "safe").as_ref(), "Safe path");
    assert_eq!(picked.matches("Safe path").count(), 1, "{picked}");
    // The Turn a reply joins, as the composer chooses it.
    let detail = |id: &str| ws.store.detail(id).unwrap();
    assert_eq!(home::follow_up_turn(&detail("b")).unwrap().as_deref(), Some("t1"));
    idle(&ws, "b");
    assert_eq!(home::follow_up_turn(&detail("b")).unwrap(), None);
    let mut claude = detail("c");
    claude.agent.harness = "claude".into();
    assert_eq!(home::follow_up_turn(&claude).unwrap().as_deref(), Some("t1"));
    claude.turns.last_mut().unwrap()["_yuzunoSource"] = json!("native");
    assert!(home::follow_up_turn(&claude).is_err(), "never a follow-up to Claude's own turn");
    claude.agent.status = "idle".into();
    assert_eq!(home::follow_up_turn(&claude).unwrap(), None);
    // A reply that is not sent leaves the ask open.
    close(&ws, "c", true);
    let reply = |choice: Option<&str>| home::ReplyInput { key: Some("decide".into()), agent_id: "c".into(),
        text: "Go".into(), client_message_id: "m1".into(), choice: choice.map(str::to_owned), version: None, title: None };
    assert!(home::reply(&ws, project.clone(), reply(Some("left"))).await.is_err());
    assert_eq!(section(&brief(&ws, "a"), "decide")["ask"]["state"], "open");
    let unknown = home::reply(&ws, project.clone(), reply(Some("up"))).await.unwrap_err();
    assert!(unknown.to_string().starts_with("choice_not_found"), "{unknown}");
    let sent = |status: &str| home::delivered(&serde_json::from_value(json!({"input":{"clientMessageId":"m","text":"t"},
        "status":status,"turnId":null,"error":null})).unwrap());
    assert!(sent("accepted") && sent("queued") && !sent("rejected") && !sent("uncertain") && !sent("sending"));
}

// T-174: a reply to a report or status card names exactly the version on
// screen. Another version or a removed card sends nothing and says so; a
// retry of a message already sent returns its receipt, card changed or not.
#[tokio::test]
async fn a_card_reply_names_the_version_on_screen_and_never_another() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("c1", 0, vec![put("news", "report"), put("now", "status"), put("decide", "ask")])).await;
    let reply = |key: &str, version: i64, title: &str, text: &str, id: &str| home::ReplyInput {
        key: Some(key.into()), agent_id: "b".into(), text: text.into(), client_message_id: id.into(),
        choice: None, version: Some(version), title: Some(title.into()) };
    let refused = |error: anyhow::Error, code: &str| {
        assert!(error.to_string().starts_with(code), "{error}");
        assert!(error.is::<crate::collaboration_credentials::MessageNotSubmitted>(), "nothing was sent: {error}");
    };
    // Core's own Workspace, whatever a client might say.
    let workspace = ws.store.workspace_id().unwrap();
    assert!(!workspace.is_empty());
    let message = home::compose_card(&workspace, "Code", &project, "news", 1, "About news", " Looks good \n");
    assert_eq!(message, format!("Reply from the user on Home, to version 1 of the Project Brief section `news` (\"About news\") \
        of Code (Workspace {workspace}, Project {project}):\n\nLooks good"));
    // A message already sent under this id: its retry returns it, though the card changed since.
    let sent = crate::model::MessageReceipt { binding: None, skills: vec![], status: "accepted".into(), turn_id: Some("t1".into()), error: None,
        input: crate::model::MessageInput { client_message_id: "r1".into(), text: message.clone(), text_blocks: None, images: vec![],
            expected_turn_id: Some("t1".into()), question: None, clarification: None } };
    let kept = sent.clone();
    ws.store.update_meta("b", "message/requested", &json!({}), move |m| m.message_receipts.push(kept)).unwrap();
    accept(&ws, "a", input("c2", 1, vec![put("news", "report")])).await;
    assert_eq!(section(&brief(&ws, "a"), "news")["version"], 2);
    let again = home::reply(&ws, project.clone(), reply("news", 1, "About news", "Looks good", "r1")).await.unwrap();
    assert_eq!((again.status.as_str(), again.input.text.as_str()), ("accepted", message.as_str()));
    let other = home::reply(&ws, project.clone(), reply("news", 1, "About news", "Something else", "r1")).await.unwrap_err();
    assert!(other.to_string().contains("already used for another message"), "{other}");
    // A new message to version 1, now gone: kept by the client, sent nowhere.
    refused(home::reply(&ws, project.clone(), reply("news", 1, "About news", "Looks good", "r2")).await.unwrap_err(), "section_changed");
    // Not another card's version, title or kind, and never an ask.
    refused(home::reply(&ws, project.clone(), reply("now", 2, "About now", "Hi", "r3")).await.unwrap_err(), "section_changed");
    refused(home::reply(&ws, project.clone(), reply("now", 1, "About news", "Hi", "r3")).await.unwrap_err(), "section_changed");
    refused(home::reply(&ws, project.clone(), reply("decide", 1, "About decide", "Hi", "r3")).await.unwrap_err(), "section_changed");
    // A removed card: its version is still in history, and still not replied to.
    accept(&ws, "a", input("c3", 2, vec![op("remove", "now")])).await;
    refused(home::reply(&ws, project.clone(), reply("now", 1, "About now", "Hi", "r4")).await.unwrap_err(), "section_removed");
    // A report the user marked seen is still the version they saw.
    sections::mark_seen(&ws.store, &project, &[("news".into(), 2)]).unwrap();
    let seen = home::reply(&ws, project.clone(), reply("news", 2, "About news", "Thanks", "r5")).await;
    assert!(seen.as_ref().is_ok() || !seen.as_ref().unwrap_err().to_string().starts_with("section_"), "{seen:?}");
    // Malformed: a title without a version, a choice, no text.
    let mut bare = reply("news", 2, "About news", "Hi", "r6");
    bare.version = None;
    assert!(home::reply(&ws, project.clone(), bare).await.is_err());
    let mut picked = reply("news", 2, "About news", "Hi", "r6");
    picked.choice = Some("left".into());
    assert!(home::reply(&ws, project.clone(), picked).await.is_err());
    assert!(home::reply(&ws, project.clone(), reply("news", 2, "About news", "  ", "r6")).await.is_err());
    // Nothing on Home changed: no ask replied, the seen mark as it was.
    let after = brief(&ws, "a");
    assert_eq!(section(&after, "decide")["ask"]["state"], "open");
    let seen_marks = sections::seen(&ws.store.db.read().unwrap(), &project).unwrap();
    assert_eq!(seen_marks.get("news").map(|(version, _)| *version), Some(2));
    assert_eq!(seen_marks.len(), 1);
}

#[test]
fn the_tools_come_from_the_contract_and_brief_get_and_update_load_without_search() {
    let listed = crate::collaboration_store::tool_definitions();
    for name in TOOLS {
        let tool = listed.iter().find(|t| t["name"] == name).expect("listed with the collaboration tools");
        assert_eq!(tool, &tool_definition(name));
        assert_eq!(tool["_meta"]["anthropic/alwaysLoad"].as_bool(), (name != "brief_guide").then_some(true), "{name}");
        assert_eq!(tool["description"], brief_contract().unwrap()["toolDescriptions"][name], "{name}");
        let parsed: rmcp::model::Tool = serde_json::from_value(tool.clone()).unwrap();
        assert_eq!(parsed.meta.is_some(), name != "brief_guide");
    }
    let schema = &tool_definition("brief_update")["inputSchema"];
    assert_eq!(schema["required"], json!(["requestId", "expectedVersion"]));
    assert!(schema["properties"].as_object().unwrap().keys().all(|key| !key.contains("agent") && key != "turnId"));
    // Core enforces the numbers the contract tells Agents.
    let limits = &brief_contract().unwrap()["limits"];
    for (key, value) in [("topics", MAX_TOPICS as u64), ("subtopicsPerTopic", MAX_SUBTOPICS as u64), ("openAsksPerAgent", MAX_OPEN_ASKS as u64),
        ("attachments", MAX_ATTACHMENTS as u64), ("snapshotFileBytes", SNAPSHOT_FILE_BYTES), ("snapshotBriefBytes", SNAPSHOT_BRIEF_BYTES),
        ("historyDays", HISTORY_DAYS as u64), ("chartSeries", attachments::CHART_SERIES as u64),
        ("chartPointsPerSeriesFromData", attachments::CHART_POINTS as u64)] {
        assert_eq!(limits[key].as_u64(), Some(value), "{key}");
    }
    assert!(hard_rules().chars().count() <= 1500);
    assert_eq!(hard_rules(), brief_contract().unwrap()["hardRules"]);
}

#[test]
fn the_guide_is_served_whole_or_by_part() {
    let whole = guide(&json!({})).unwrap();
    assert_eq!(whole["guide"], brief_contract().unwrap()["guide"]);
    assert_eq!(whole["schemaVersion"], json!(brief_schema_version()));
    assert_eq!(guide(&json!({"part":"charts"})).unwrap()["guide"], brief_contract().unwrap()["guideParts"]["charts"]);
    assert!(guide(&json!({"part":"nope"})).unwrap_err().to_string().starts_with("invalid_input"));
    assert!(guide(&json!({"other":1})).is_err());
}

#[tokio::test]
async fn the_generated_validator_checks_sections_for_core() {
    let (_dir, ws, project) = lab();
    let checker = Checker::Node(Arc::new(crate::results::Validator::from_env()));
    let mut good = put("decide", "ask");
    good["time"] = json!({"due":"2026-11-01T00:00:00Z"});
    let accepted = update::update(&ws, &checker, "a", input("a1", 0, vec![good])).await.unwrap();
    assert!(accepted.is_ok(), "{accepted:?}");
    let read = brief(&ws, "a");
    assert_eq!(section(&read, "decide")["ask"]["question"], "Which way?");
    assert_eq!(section(&read, "decide")["time"]["due"], "2026-11-01T00:00:00Z");
    let mut bad = put("other", "ask");
    bad["ask"]["reply"] = json!({});
    let rejected = update::update(&ws, &checker, "a", input("a2", 1, vec![bad])).await.unwrap().unwrap_err();
    assert_eq!(rejected["problems"][0]["code"], "ask_without_reply", "{rejected}");
    assert_eq!(rejected["problems"][0]["path"], "changes[0].ask.reply");
    assert_eq!(rejected["problems"][0]["guide"], "brief_guide ask");
    assert_eq!(version(&ws, &project), 1);
}

#[tokio::test]
async fn routes_take_a_percent_encoded_section_key_as_one_segment() {
    use tower::ServiceExt;
    let (dir, ws, project) = lab();
    let data = dir.path().join("loss.csv");
    std::fs::write(&data, "step,loss\n1,2\n").unwrap();
    let mut change = put("round-12/review", "report");
    change["attachments"] = json!([{"name":"loss.csv","path":data}]);
    accept(&ws, "a", input("a1", 0, vec![change])).await;
    let app = router().with_state(ws.clone());
    let get = |uri: String| axum::http::Request::builder().uri(uri).body(axum::body::Body::empty()).unwrap();
    let response = app.clone().oneshot(get(format!("/api/projects/{project}/brief/attachments/round-12%2Freview/loss.csv"))).await.unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["content-type"], "text/csv");
    assert_eq!(response.headers()["content-security-policy"], "sandbox; default-src 'none'");
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    assert_eq!(&bytes[..], b"step,loss\n1,2\n");
    let response = app.clone().oneshot(get(format!("/api/projects/{project}/brief/attachments/round-12%2Fnope/loss.csv"))).await.unwrap();
    assert_eq!(response.status(), 404);
    let response = app.oneshot(get("/api/home".into())).await.unwrap();
    assert_eq!(response.status(), 200);
}

#[tokio::test]
async fn over_mcp_brief_update_answers_with_structured_receipts_and_rejections() {
    use rmcp::{
        model::CallToolRequestParams,
        transport::{streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport},
        ServiceExt as _,
    };
    let (_dir, ws, project) = lab();
    // The brief_ prefix reaches this module through Workspace::collaboration_call.
    assert_eq!(ws.collaboration_call(Some("a"), "brief_get", json!({})).await.unwrap()["projectId"], project);
    assert_eq!(ws.collaboration_call(Some("a"), "brief_guide", json!({"part":"ask"})).await.unwrap()["part"], "ask");
    assert!(ws.collaboration_call(None, "brief_update", json!({"requestId":"u"})).await.unwrap_err().to_string().starts_with("agent_only"));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let config = crate::collaboration_mcp::agent_http_config(&ws, "a", &format!("http://127.0.0.1:{port}")).unwrap();
    let token = config["headers"]["Authorization"].as_str().unwrap().strip_prefix("Bearer ").unwrap().to_owned();
    let app = crate::collaboration_mcp::router(ws.clone(), port);
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let transport = StreamableHttpClientTransport::with_client(
        reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().unwrap(),
        StreamableHttpClientTransportConfig::with_uri(format!("http://127.0.0.1:{port}/mcp/a")).auth_header(token),
    );
    let client = tokio::time::timeout(std::time::Duration::from_secs(10), ().serve(transport)).await.unwrap().unwrap();
    let tools = client.list_all_tools().await.unwrap();
    for (name, always) in [("brief_get", true), ("brief_update", true), ("brief_guide", false)] {
        let tool = tools.iter().find(|tool| tool.name == name).unwrap();
        assert_eq!(tool.meta.as_ref().and_then(|meta| meta.0.get("anthropic/alwaysLoad")).cloned(), always.then_some(json!(true)), "{name}");
    }
    let update = |arguments: Value| CallToolRequestParams::new("brief_update").with_arguments(arguments.as_object().unwrap().clone());
    let rejected = client.call_tool(update(json!({"requestId":"m1","expectedVersion":5,"noChange":true}))).await.unwrap();
    assert_eq!(rejected.is_error, Some(true));
    let rejected = rejected.structured_content.unwrap();
    assert_eq!((rejected["accepted"].clone(), rejected["problems"][0]["code"].clone()), (json!(false), json!("version_conflict")));
    assert_eq!(rejected["latest"]["version"], 0);
    let accepted = client.call_tool(update(json!({"requestId":"m2","expectedVersion":0,"changes":[put("plan", "report")]}))).await.unwrap();
    assert_ne!(accepted.is_error, Some(true), "{:?}", accepted.structured_content);
    let accepted = accepted.structured_content.unwrap();
    assert_eq!((accepted["receipt"]["agentId"].clone(), accepted["receipt"]["turnId"].clone()), (json!("a"), json!("t1")));
    // Identity comes from the endpoint, never from arguments.
    let claimed = client.call_tool(update(json!({"requestId":"m3","expectedVersion":1,"noChange":true,"agentId":"b"}))).await.unwrap();
    assert_eq!(claimed.is_error, Some(true));
    assert_eq!(turn_receipt(&ws.store, "b", "t1").unwrap(), None);
    // No Agent-facing operation changes the list; only the user HTTP route.
    assert!(!tools.iter().any(|tool| tool.name.contains("editor")));
    assert!(ws.collaboration_call(Some("a"), "home_editors_set", json!({"editorAgentIds":["a"]})).await.is_err());
    editors::save(&ws.store, &project, 0, Some(vec![])).unwrap();
    let refused = client.call_tool(update(input("m4", 1, vec![put("plan", "report")]))).await.unwrap();
    assert_eq!(refused.structured_content.unwrap()["problems"][0]["code"], "ask_only");
    let ask = client.call_tool(update(input("m5", 1, vec![put("plan/question", "ask")]))).await.unwrap();
    assert_ne!(ask.is_error, Some(true), "{:?}", ask.structured_content);
    let _ = client.cancel().await;
    server.abort();
}

#[tokio::test]
async fn an_owner_moved_out_of_the_project_leaves_its_sections_to_claim_unless_moved_back_first() {
    let (_dir, ws, project) = lab();
    let other = ws.store.create_project("Research", BTreeMap::new()).unwrap().id;
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report")])).await;
    accept(&ws, "c", input("c1", 1, vec![put("notes", "status")])).await;
    // a moves to another Project, c to none.
    ws.store.set_agent_project("a", Some(&other)).unwrap();
    ws.store.set_agent_project("c", None).unwrap();
    let read = brief(&ws, "b");
    assert_eq!(section(&read, "plan")["owner"], json!({"agentId":"a","name":"Agent a","state":"moved"}));
    assert_eq!(section(&read, "notes")["owner"]["state"], "moved");
    assert_eq!(home::build(&ws.store).unwrap()["projects"][0]["brief"]["sections"][0]["owner"]["state"], "moved");
    // The moved owner can no longer write there.
    let left = reject(&ws, "a", json!({"requestId":"a2","projectId":project,"expectedVersion":2,"changes":[put("plan", "report")]})).await;
    assert_eq!(codes(&left), ["not_owner"]);
    assert!(left["problems"][0]["reason"].as_str().unwrap().contains("left this Project"), "{left}");
    let rejected = reject(&ws, "b", input("b1", 2, vec![put("plan", "report")])).await;
    assert_eq!(codes(&rejected), ["not_owner"]);
    assert!(rejected["problems"][0]["reason"].as_str().unwrap().contains("left this Project"));
    accept(&ws, "b", input("b2", 2, vec![op("claim", "plan")])).await;
    assert_eq!(section(&brief(&ws, "b"), "plan")["owner"]["agentId"], "b");
    // Moved back after the claim: the section stays the claimer's.
    ws.store.set_agent_project("a", Some(&project)).unwrap();
    assert_eq!(codes(&reject(&ws, "a", input("a3", 3, vec![put("plan", "report")])).await), ["not_owner"]);
    // Moved back before anyone claims: c owns its section again.
    ws.store.set_agent_project("c", Some(&project)).unwrap();
    assert_eq!(section(&brief(&ws, "b"), "notes")["owner"]["state"], "active");
    assert_eq!(codes(&reject(&ws, "b", input("b3", 3, vec![op("claim", "notes")])).await), ["not_orphan"]);
    accept(&ws, "c", input("c2", 3, vec![put("notes", "status")])).await;
    // An Agent that never owned anything there is simply not in the Project.
    let outsider = json!({"requestId":"d1","projectId":project,"expectedVersion":4,"noChange":true});
    assert_eq!(codes(&reject(&ws, "d", outsider).await), ["not_in_project"]);
}

#[path = "editors_tests.rs"]
mod editors_tests;

/// The user's Overview layout: a summary across the top, then two columns.
fn overview() -> Value {
    json!({"op":"put","key":"overview","kind":"status","title":"Overview",
        "status":{"asOf":"2026-10-18T05:00:00Z","validFor":86400},
        "attachments":[{"name":"spec","url":"https://example.com/spec","caption":"The plan"}],
        "body":{"root":"body","elements":{
            "body":{"type":"BriefBody","props":{},"children":["now","split","files"]},
            "files":{"type":"Attachments","props":{"items":[{"name":"spec"}]}},
            "now":{"type":"Group","props":{"title":"Where we are","tone":"accent"},"children":["summary"]},
            "summary":{"type":"Markdown","props":{"text":"Converging."}},
            "split":{"type":"Columns","props":{"widths":[3,2]},"children":["work","next"]},
            "work":{"type":"Group","props":{"title":"Progress"},"children":["progress"]},
            "progress":{"type":"Markdown","props":{"text":"Step 1 of 3."}},
            "next":{"type":"Group","props":{"title":"Findings"},"children":["findings"]},
            "findings":{"type":"Markdown","props":{"text":"None yet."}}}}})
}

fn edit(key: &str, elements: Value) -> Value {
    json!({"op":"edit","key":key,"elements":elements})
}

fn markdown(text: &str) -> Value {
    json!({"type":"Markdown","props":{"text":text}})
}

#[tokio::test]
async fn an_edit_replaces_only_the_named_blocks_and_keeps_layout_attachments_and_status() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![overview()])).await;
    let before = section(&brief(&ws, "a"), "overview").clone();
    let changed = accept(&ws, "a", input("a2", 1, vec![edit("overview", json!({"progress":markdown("Step 2 of 3.")}))])).await;
    assert_eq!(changed["sections"], json!([{"key":"overview","version":2}]));
    let after = section(&brief(&ws, "a"), "overview").clone();
    assert_eq!(after["body"]["elements"]["progress"]["props"]["text"], "Step 2 of 3.");
    // Every other block, the order, the title, the attachment snapshot and the status are as they were.
    let mut expected = before["body"].clone();
    expected["elements"]["progress"] = markdown("Step 2 of 3.");
    assert_eq!(after["body"], expected);
    for field in ["title", "attachments", "status", "kind", "owner"] {
        assert_eq!(after[field], before[field], "{field}");
    }
    // A second edit, with the status refreshed, changes just that block and the status.
    let at = "2026-10-18T06:00:00Z";
    let mut second = edit("overview", json!({"findings":markdown("Loss falls 6% after warm-up.")}));
    second["status"] = json!({"asOf":at,"validFor":86400});
    accept(&ws, "a", input("a3", 2, vec![second])).await;
    let latest = section(&brief(&ws, "a"), "overview").clone();
    assert_eq!(latest["body"]["elements"]["findings"]["props"]["text"], "Loss falls 6% after warm-up.");
    assert_eq!(latest["body"]["elements"]["progress"]["props"]["text"], "Step 2 of 3.");
    assert_eq!(latest["status"]["asOf"], at);
    assert_eq!(latest["attachments"], before["attachments"]);
    assert_eq!(latest["version"], 3);
    // A new block may join as the child of a block the edit replaces.
    let grown = edit("overview", json!({
        "next":{"type":"Group","props":{"title":"Findings"},"children":["findings","jobs"]},
        "jobs":{"type":"LiveRefs","props":{"items":[{"kind":"task","id":"T-12"}]}}}));
    accept(&ws, "a", input("a4", 3, vec![grown])).await;
    let grown = section(&brief(&ws, "a"), "overview").clone();
    assert_eq!(grown["body"]["elements"]["next"]["children"], json!(["findings","jobs"]));
    assert_eq!(grown["body"]["elements"]["jobs"]["type"], "LiveRefs");
    assert_eq!(version(&ws, &project), 4);
}

#[tokio::test]
async fn an_edit_never_reopens_a_replied_ask() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("decide", "ask")])).await;
    assert!(sections::mark_replied(&ws.store, &project, "decide", "Left: go").unwrap());
    accept(&ws, "a", input("a2", 1, vec![edit("decide", json!({"note":markdown("More context.")}))])).await;
    let ask = section(&brief(&ws, "a"), "decide").clone();
    assert_eq!((ask["ask"]["state"].clone(), ask["ask"]["replyText"].clone()), (json!("replied"), json!("Left: go")));
    assert_eq!(ask["ask"]["question"], "Which way?");
    assert_eq!(ask["body"]["elements"]["note"]["props"]["text"], "More context.");
}

#[tokio::test]
async fn an_edit_is_refused_whole_for_unknown_or_root_blocks_other_owners_and_stale_versions() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![overview()])).await;
    let unchanged = section(&brief(&ws, "a"), "overview").clone();
    let refused = reject(&ws, "a", input("a2", 1, vec![edit("overview", json!({"nope":markdown("x")}))])).await;
    assert_eq!(codes(&refused), ["unknown_element"]);
    assert_eq!(refused["problems"][0]["path"], "changes[0].elements.nope");
    let refused = reject(&ws, "a", input("a3", 1, vec![edit("overview", json!({"body":{"type":"BriefBody","props":{},"children":["now"]}}))])).await;
    assert_eq!(codes(&refused), ["edit_root"]);
    assert_eq!(codes(&reject(&ws, "b", input("b1", 1, vec![edit("overview", json!({"progress":markdown("Mine now.")}))])).await), ["not_owner"]);
    assert_eq!(codes(&reject(&ws, "a", input("a4", 1, vec![edit("missing", json!({"x":markdown("x")}))])).await), ["not_found"]);
    assert_eq!(codes(&reject(&ws, "a", input("a5", 0, vec![edit("overview", json!({"progress":markdown("Late.")}))])).await), ["version_conflict"]);
    // Malformed edits.
    let mut titled = edit("overview", json!({"progress":markdown("x")}));
    titled["title"] = json!("New title");
    assert_eq!(codes(&reject(&ws, "a", input("a6", 1, vec![titled])).await), ["invalid_change"]);
    assert_eq!(codes(&reject(&ws, "a", input("a7", 1, vec![edit("overview", json!({}))])).await), ["invalid_change"]);
    assert_eq!(codes(&reject(&ws, "a", input("a8", 1, vec![edit("overview", json!({"progress":"text"}))])).await), ["invalid_change"]);
    // A batch is all or nothing: the valid put beside a refused edit is not kept.
    let mixed = input("a9", 1, vec![put("notes", "report"), edit("overview", json!({"nope":markdown("x")}))]);
    assert_eq!(codes(&reject(&ws, "a", mixed).await), ["unknown_element"]);
    let read = brief(&ws, "a");
    assert!(section(&read, "notes").is_null(), "nothing of the batch is kept");
    assert_eq!(section(&read, "overview"), &unchanged);
    assert_eq!(version(&ws, &project), 1);
}

#[tokio::test]
async fn a_retried_edit_is_answered_once_and_not_applied_twice() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![overview()])).await;
    let call = input("same", 1, vec![edit("overview", json!({"progress":markdown("Step 2 of 3.")}))]);
    let first = accept(&ws, "a", call.clone()).await;
    let again = accept(&ws, "a", call).await;
    assert_eq!(first, again);
    assert_eq!(version(&ws, &project), 2);
    assert_eq!(section(&brief(&ws, "a"), "overview")["version"], 2);
}

#[tokio::test]
async fn the_generated_validator_checks_layout_and_edits_whole() {
    let (_dir, ws, project) = lab();
    let checker = Checker::Node(Arc::new(crate::results::Validator::from_env()));
    let accepted = update::update(&ws, &checker, "a", input("a1", 0, vec![overview()])).await.unwrap();
    assert!(accepted.is_ok(), "{accepted:?}");
    // An edit that leaves a block out of the tree is checked whole, and the
    // problem names the edit's own path.
    let orphaning = edit("overview", json!({"next":{"type":"Group","props":{"title":"Findings"},"children":[]}}));
    let rejected = update::update(&ws, &checker, "a", input("a2", 1, vec![orphaning])).await.unwrap().unwrap_err();
    assert_eq!(rejected["problems"][0]["code"], "unused_component", "{rejected}");
    assert_eq!(rejected["problems"][0]["path"], "changes[0].elements");
    // Columns need one width per child.
    let mismatched = edit("overview", json!({"split":{"type":"Columns","props":{"widths":[1,1,1]},"children":["work","next"]}}));
    let rejected = update::update(&ws, &checker, "a", input("a3", 1, vec![mismatched])).await.unwrap().unwrap_err();
    assert_eq!(rejected["problems"][0]["code"], "columns_widths", "{rejected}");
    assert_eq!(rejected["problems"][0]["path"], "changes[0].elements.split.props.widths");
    // status only on a status section, through the same check.
    update::update(&ws, &checker, "a", input("a4", 1, vec![put("notes", "report")])).await.unwrap().unwrap();
    let mut misplaced = edit("notes", json!({"note":markdown("x")}));
    misplaced["status"] = json!({"asOf":"2026-10-18T06:00:00Z","validFor":600});
    let rejected = update::update(&ws, &checker, "a", input("a5", 2, vec![misplaced])).await.unwrap().unwrap_err();
    assert_eq!(rejected["problems"][0]["code"], "misplaced_field", "{rejected}");
    assert_eq!(rejected["problems"][0]["path"], "changes[0].status");
    let edited = update::update(&ws, &checker, "a", input("a6", 2, vec![edit("overview", json!({"progress":markdown("Step 2 of 3.")}))])).await.unwrap();
    assert!(edited.is_ok(), "{edited:?}");
    assert_eq!(version(&ws, &project), 3);
}

#[tokio::test]
async fn an_edit_keeps_the_snapshots_and_the_charts_that_read_them() {
    let (dir, ws, project) = lab();
    let checker = Checker::Node(Arc::new(crate::results::Validator::from_env()));
    let file = dir.path().join("loss.csv");
    std::fs::write(&file, "step,loss\n1,0.5\n2,0.4\n").unwrap();
    let change = json!({"op":"put","key":"curves","kind":"report","title":"Curves",
        "attachments":[{"name":"loss.csv","path":file,"caption":"Loss per step"}],
        "body":{"root":"body","elements":{
            "body":{"type":"BriefBody","props":{},"children":["note","loss"]},
            "note":markdown("Falling."),
            "loss":{"type":"LineChart","props":{"id":"loss","title":"Loss","x":{"label":"Step"},"y":{"label":"Loss"},
                "data":{"attachment":"loss.csv","x":"step","series":[{"name":"Loss","column":"loss"}]}}}}}});
    update::update(&ws, &checker, "a", input("a1", 0, vec![change])).await.unwrap().unwrap();
    let before = section(&brief(&ws, "a"), "curves")["attachments"].clone();
    // The file changes on disk; the edit takes no new snapshot of it.
    std::fs::write(&file, "step,loss\n1,9\n").unwrap();
    let edited = update::update(&ws, &checker, "a", input("a2", 1, vec![edit("curves", json!({"note":markdown("Still falling.")}))])).await.unwrap();
    assert!(edited.is_ok(), "{edited:?}");
    let after = section(&brief(&ws, "a"), "curves").clone();
    assert_eq!((after["version"].clone(), after["attachments"].clone()), (json!(2), before));
    let cache = attachments::dir(&ws.data_dir);
    let (snapshot, _) = attachments::snapshot_file(&ws.store, &cache, &project, "curves", "loss.csv", Some(2)).unwrap().ok().unwrap();
    assert_eq!(std::fs::read_to_string(snapshot).unwrap(), "step,loss\n1,0.5\n2,0.4\n");
    let chart = attachments::chart(&ws.store, &cache, &project, "curves", "loss", Some(2)).unwrap().ok().unwrap();
    assert_eq!(chart["series"][0]["points"], json!([[1.0, 0.5], [2.0, 0.4]]));
    // With the file gone from disk, an edit still keeps the snapshot as written.
    std::fs::remove_file(&file).unwrap();
    let edited = update::update(&ws, &checker, "a", input("a3", 2, vec![edit("curves", json!({"note":markdown("Flat now.")}))])).await.unwrap();
    assert!(edited.is_ok(), "{edited:?}");
    let latest = section(&brief(&ws, "a"), "curves").clone();
    assert_eq!((latest["version"].clone(), latest["attachments"].clone()), (json!(3), after["attachments"].clone()));
    let (snapshot, _) = attachments::snapshot_file(&ws.store, &cache, &project, "curves", "loss.csv", Some(3)).unwrap().ok().unwrap();
    assert_eq!(std::fs::read_to_string(snapshot).unwrap(), "step,loss\n1,0.5\n2,0.4\n");
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_snapshots"), 1);
    let rejected = update::update(&ws, &checker, "a", input("hide-chart", 3, vec![edit("curves", json!({"loss":markdown("No chart now.")}))])).await.unwrap().unwrap_err();
    assert_eq!(codes(&rejected), ["unused_attachment"]);
    assert_eq!(section(&brief(&ws, "a"), "curves"), &latest);
}

#[tokio::test]
async fn unused_attachments_are_rejected_before_staging_and_last_use_removal_is_atomic() {
    for key in ["tasks-board", "development"] {
        let (dir, ws, project) = lab();
        let checker = Checker::Node(Arc::new(crate::results::Validator::from_env()));
        let file = dir.path().join("preview.png");
        std::fs::write(&file, b"fixture image bytes").unwrap();
        let mut change = put(key, "status");
        change["attachments"] = json!([{"name":"preview.png","path":file}]);
        let rejected = update::update(&ws, &checker, "a", input("unused", 0, vec![change.clone()])).await.unwrap().unwrap_err();
        assert_eq!(codes(&rejected), ["unused_attachment"]);
        assert_eq!(rejected["problems"][0]["path"], "changes[0].attachments.0.name");
        assert_eq!(rejected["problems"][0]["guide"], "brief_guide attachments");
        assert!(rejected["problems"][0]["reason"].as_str().unwrap().contains("reachable Attachments block"));
        assert_eq!(version(&ws, &project), 0);
        assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_receipts"), 0);
        assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_snapshots"), 0);

        // The smallest repair is a displayed reference; no automatic layout rewrite.
        change["body"]["elements"]["note"] = json!({"type":"Attachments","props":{"items":[{"name":"preview.png"}]}});
        update::update(&ws, &checker, "a", input("repaired", 0, vec![change])).await.unwrap().unwrap();
        let before = section(&brief(&ws, "a"), key).clone();
        let remove_last = edit(key, json!({"note":markdown("Preview removed.")}));
        let rejected = update::update(&ws, &checker, "a", input("remove-last", 1, vec![remove_last])).await.unwrap().unwrap_err();
        assert_eq!(codes(&rejected), ["unused_attachment"]);
        assert_eq!(section(&brief(&ws, "a"), key), &before);
        assert_eq!(version(&ws, &project), 1);
        assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_receipts"), 1);
        let (snapshot, _) = attachments::snapshot_file(&ws.store, &attachments::dir(&ws.data_dir), &project, key, "preview.png", None).unwrap().ok().unwrap();
        assert_eq!(std::fs::read(snapshot).unwrap(), b"fixture image bytes");
    }
}

#[tokio::test]
async fn legacy_unused_attachments_stay_readable_and_unrelated_edits_keep_asks_and_snapshots() {
    let (dir, ws, project) = lab();
    let checker = Checker::Node(Arc::new(crate::results::Validator::from_env()));
    let file = dir.path().join("old.png");
    std::fs::write(&file, b"original snapshot").unwrap();
    let mut ask = put("legacy", "ask");
    ask["attachments"] = json!([{"name":"old.png","path":file}]);
    let mut report = put("old-report", "report");
    report["attachments"] = ask["attachments"].clone();
    // Persist exactly what pre-upgrade Core accepted, without the new validator.
    accept(&ws, "a", input("legacy", 0, vec![ask.clone(), report.clone()])).await;
    assert!(sections::mark_replied(&ws.store, &project, "legacy", "Left: go").unwrap());
    let before = section(&brief(&ws, "a"), "legacy").clone();
    std::fs::remove_file(&file).unwrap();
    // Editing an unrelated block must not restage files or reopen an Ask.
    update::update(&ws, &checker, "a", input("text", 1, vec![edit("legacy", json!({"note":markdown("More context.")}))])).await.unwrap().unwrap();
    let after = section(&brief(&ws, "a"), "legacy").clone();
    assert_eq!(after["attachments"], before["attachments"]);
    assert_eq!(after["ask"], before["ask"]);
    assert_eq!(after["body"]["elements"]["note"]["props"]["text"], "More context.");
    let (snapshot, _) = attachments::snapshot_file(&ws.store, &attachments::dir(&ws.data_dir), &project, "legacy", "old.png", None).unwrap().ok().unwrap();
    assert_eq!(std::fs::read(snapshot).unwrap(), b"original snapshot");
    // Historical reads likewise do not run today's write validator.
    sections::mark_seen(&ws.store, &project, &[("old-report".into(), 1)]).unwrap();
    let home = home::build(&ws.store).unwrap();
    let historical = &home["projects"][0]["brief"]["history"][0];
    assert_eq!(historical["key"], "old-report");
    assert_eq!(historical["body"], report["body"]);
    assert_eq!(historical["attachments"][0]["snapshot"], true);

    // Full replacements are strict, even for legacy content, and cannot forge context.
    let rejected = update::update(&ws, &checker, "a", input("put", 2, vec![ask.clone()])).await.unwrap().unwrap_err();
    assert_eq!(codes(&rejected), ["unused_attachment"]);
    let mut forged = edit("legacy", json!({"note":markdown("Spoofed.")}));
    forged["previousBody"] = body("fake");
    assert_eq!(codes(&reject(&ws, "a", input("forged", 2, vec![forged])).await), ["invalid_change"]);
    assert_eq!(section(&brief(&ws, "a"), "legacy"), &after);

    // Repair through edit keeps the attachment snapshot and the replied Ask.
    update::update(&ws, &checker, "a", input("show", 2, vec![edit("legacy", json!({"note":{"type":"Attachments","props":{"items":[{"name":"old.png"}]}}}))])).await.unwrap().unwrap();
    let repaired = section(&brief(&ws, "a"), "legacy").clone();
    let rejected = update::update(&ws, &checker, "a", input("regress", 3, vec![edit("legacy", json!({"note":markdown("Hidden again.")}))])).await.unwrap().unwrap_err();
    assert_eq!(codes(&rejected), ["unused_attachment"]);
    assert_eq!(section(&brief(&ws, "a"), "legacy"), &repaired);
    assert_eq!(repaired["ask"], before["ask"]);
    assert_eq!(repaired["attachments"], before["attachments"]);
    assert_eq!(version(&ws, &project), 3);
}

#[tokio::test]
async fn an_ask_only_member_edits_only_its_own_ask_by_its_stored_kind() {
    let (_dir, ws, project) = lab();
    // b wrote a status and an ask while it could edit content; then only a may.
    accept(&ws, "b", input("b1", 0, vec![put("old", "status"), put("question", "ask")])).await;
    editors::save(&ws.store, &project, 0, Some(vec!["a".into()])).unwrap();
    // Its old status is regular content: the edit is refused and nothing changes.
    assert_eq!(codes(&reject(&ws, "b", input("b2", 1, vec![edit("old", json!({"note":markdown("Still mine?")}))])).await), ["ask_only"]);
    // A batch of an allowed ask edit and a refused status edit is refused whole.
    let mixed = input("b3", 1, vec![edit("question", json!({"note":markdown("Context.")})), edit("old", json!({"note":markdown("x")}))]);
    assert!(codes(&reject(&ws, "b", mixed).await).contains(&"ask_only".into()));
    assert_eq!(version(&ws, &project), 1);
    assert_eq!(section(&brief(&ws, "b"), "question")["body"]["elements"]["note"]["props"]["text"], "Hello");
    // Its own ask it may edit, and a reply stays a reply.
    assert!(sections::mark_replied(&ws.store, &project, "question", "Left").unwrap());
    accept(&ws, "b", input("b4", 1, vec![edit("question", json!({"note":markdown("Context.")}))])).await;
    let ask = section(&brief(&ws, "b"), "question").clone();
    assert_eq!((ask["ask"]["state"].clone(), ask["body"]["elements"]["note"]["props"]["text"].clone()), (json!("replied"), json!("Context.")));
    // An editor still edits only its own sections.
    assert_eq!(codes(&reject(&ws, "a", input("a1", 2, vec![edit("question", json!({"note":markdown("Mine now.")}))])).await), ["not_owner"]);
}

thread_local! {
    /// Run once by the next FAKE_THEN check: while Core checks a change,
    /// after it read the section and before it writes.
    static BETWEEN: std::cell::RefCell<Option<Box<dyn FnOnce()>>> = std::cell::RefCell::new(None);
}
fn fake_then(section: &Value) -> Result<Value, Value> {
    if let Some(run) = BETWEEN.with(|between| between.borrow_mut().take()) {
        run();
    }
    fake(section)
}

#[tokio::test]
async fn a_reply_arriving_while_an_edit_is_checked_is_kept() {
    let (_dir, ws, project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("decide", "ask")])).await;
    let (store, at) = (ws.clone(), project.clone());
    BETWEEN.with(|between| {
        *between.borrow_mut() = Some(Box::new(move || assert!(sections::mark_replied(&store.store, &at, "decide", "Left: go").unwrap())))
    });
    let answer = update::update(&ws, &Checker::Fake(fake_then), "a", input("a2", 1, vec![edit("decide", json!({"note":markdown("More context.")}))]))
        .await
        .unwrap();
    assert!(answer.is_ok(), "{answer:?}");
    assert!(BETWEEN.with(|between| between.borrow().is_none()), "the reply landed between the read and the write");
    let ask = section(&brief(&ws, "a"), "decide").clone();
    assert_eq!((ask["ask"]["state"].clone(), ask["ask"]["replyText"].clone()), (json!("replied"), json!("Left: go")));
    assert_eq!(ask["body"]["elements"]["note"]["props"]["text"], "More context.");
    assert_eq!(ask["version"], 2);
}

#[tokio::test]
async fn home_names_each_section_by_an_id_that_outlives_edits_but_not_a_rewrite() {
    let (_dir, ws, _project) = lab();
    let shown = |ws: &Workspace, key: &str| {
        let view = home::build(&ws.store).unwrap();
        view["projects"][0]["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).cloned().unwrap_or(Value::Null)
    };
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report"), put("notes", "report")])).await;
    let first = shown(&ws, "plan")["id"].clone();
    assert!(first.is_i64(), "{first}");
    assert_ne!(first, shown(&ws, "notes")["id"], "one id per section");
    // A new version, whole or by block, is the same section.
    accept(&ws, "a", input("a2", 1, vec![put("plan", "report")])).await;
    accept(&ws, "a", input("a3", 2, vec![json!({"op":"edit","key":"plan","elements":{"note":{"type":"Markdown","props":{"text":"Edited."}}}})])).await;
    assert_eq!((shown(&ws, "plan")["id"].clone(), shown(&ws, "plan")["version"].clone()), (first.clone(), json!(3)));
    // Removed and written again under the same key: another section.
    accept(&ws, "a", input("a4", 3, vec![op("remove", "plan")])).await;
    accept(&ws, "a", input("a5", 4, vec![put("plan", "report")])).await;
    let again = shown(&ws, "plan");
    assert!(again["id"].is_i64() && again["id"] != first, "{again}");
    // Agents read their Brief without it.
    assert!(section(&brief(&ws, "a"), "plan").get("id").is_none());
}

#[tokio::test]
async fn a_report_marked_seen_is_the_same_section_when_its_owner_writes_it_again() {
    let (_dir, ws, project) = lab();
    let panel = |ws: &Workspace| home::build(&ws.store).unwrap()["projects"][0]["brief"].clone();
    let live = |ws: &Workspace, key: &str| {
        panel(ws)["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).cloned().unwrap_or(Value::Null)
    };
    let history = |ws: &Workspace, key: &str| {
        panel(ws)["history"].as_array().unwrap().iter().filter(|s| s["key"] == key).cloned().collect::<Vec<_>>()
    };
    accept(&ws, "a", input("a1", 0, vec![put("notes", "report")])).await;
    let id = live(&ws, "notes")["id"].clone();
    // Seen at its current version, the report moves to history under its id.
    sections::mark_seen(&ws.store, &project, &[("notes".into(), 1)]).unwrap();
    assert!(live(&ws, "notes").is_null());
    let seen = history(&ws, "notes");
    assert_eq!((seen[0]["id"].clone(), seen[0]["historyReason"].clone(), seen[0]["currentSource"].clone()), (id.clone(), json!("seen"), json!(true)));
    // Its owner writes it again: the same section, live again.
    accept(&ws, "a", input("a2", 1, vec![put("notes", "report")])).await;
    assert_eq!((live(&ws, "notes")["id"].clone(), live(&ws, "notes")["version"].clone()), (id.clone(), json!(2)));
    // And again after the next Seen.
    sections::mark_seen(&ws.store, &project, &[("notes".into(), 2)]).unwrap();
    accept(&ws, "a", input("a3", 2, vec![put("notes", "report")])).await;
    assert_eq!(live(&ws, "notes")["id"], id);
    // Removed, then written again: another section.
    accept(&ws, "a", input("a4", 3, vec![op("remove", "notes")])).await;
    assert_eq!(history(&ws, "notes")[0]["historyReason"], "removed");
    accept(&ws, "a", input("a5", 4, vec![put("notes", "report")])).await;
    let rewritten = live(&ws, "notes")["id"].clone();
    assert!(rewritten.is_i64() && rewritten != id, "{rewritten}");
    // Another Agent writing a key after its owner's report was seen: another section.
    sections::mark_seen(&ws.store, &project, &[("notes".into(), 5)]).unwrap();
    accept(&ws, "b", input("b1", 5, vec![put("notes", "report")])).await;
    let other = live(&ws, "notes")["id"].clone();
    assert!(other != rewritten && other != id, "{other}");
    // A seen report whose owner may no longer edit Home is not a current source.
    accept(&ws, "c", input("c1", 6, vec![put("log", "report")])).await;
    sections::mark_seen(&ws.store, &project, &[("log".into(), 1)]).unwrap();
    assert_eq!(history(&ws, "log")[0]["currentSource"], true);
    editors::save(&ws.store, &project, 0, Some(vec!["a".into(), "b".into()])).unwrap();
    assert_eq!(history(&ws, "log")[0]["currentSource"], false);
}

#[tokio::test]
async fn after_history_expires_a_seen_report_continues_and_versions_keep_rising() {
    let (_dir, ws, project) = lab();
    let brief = |ws: &Workspace| home::build(&ws.store).unwrap()["projects"][0].clone();
    let live = |ws: &Workspace, key: &str| {
        brief(ws)["brief"]["sections"].as_array().unwrap().iter().find(|s| s["key"] == key).cloned().unwrap_or(Value::Null)
    };
    // History older than 30 days goes, body and attachments with it; each
    // key's ending (owner, identity, version, reason) stays.
    let expire = |ws: &Workspace| {
        let old = (chrono::Utc::now() - chrono::Duration::days(40)).to_rfc3339();
        let mut writer = ws.store.db.write().unwrap();
        let tx = writer.transaction().unwrap();
        tx.execute("UPDATE project_brief_sections SET history_at=?1 WHERE live=0", [&old]).unwrap();
        sections::expire_history(&tx).unwrap();
        tx.commit().unwrap();
    };
    accept(&ws, "a", input("a1", 0, vec![put("notes", "report")])).await;
    let id = live(&ws, "notes")["id"].clone();
    sections::mark_seen(&ws.store, &project, &[("notes".into(), 1)]).unwrap();
    expire(&ws);
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_sections WHERE key='notes'"), 0, "the seen report itself is gone");
    // Its owner writes it again: the same section, a newer version, and new to the user.
    accept(&ws, "a", input("a2", 1, vec![put("notes", "report")])).await;
    let again = live(&ws, "notes");
    assert_eq!((again["id"].clone(), again["version"].clone(), again["seen"]["version"].clone()), (id.clone(), json!(2), json!(1)));
    assert_eq!(brief(&ws)["unseen"], 1, "the new version is not taken for the one seen");
    // Removed and expired, then written again: another section, versions still rising.
    accept(&ws, "a", input("a3", 2, vec![op("remove", "notes")])).await;
    expire(&ws);
    accept(&ws, "a", input("a4", 3, vec![put("notes", "report")])).await;
    let rewritten = live(&ws, "notes");
    assert!(rewritten["id"] != id, "{rewritten}");
    assert_eq!(rewritten["version"], 3);
    // Seen and expired, then another Agent writes the key: another section.
    sections::mark_seen(&ws.store, &project, &[("notes".into(), 3)]).unwrap();
    expire(&ws);
    accept(&ws, "b", input("b1", 4, vec![put("notes", "report")])).await;
    let other = live(&ws, "notes");
    assert!(other["id"] != id && other["id"] != rewritten["id"], "{other}");
    assert_eq!(other["version"], 4);
    // The first owner's earlier seen section never comes back under this key.
    accept(&ws, "b", input("b2", 5, vec![op("remove", "notes")])).await;
    accept(&ws, "a", input("a5", 6, vec![put("notes", "report")])).await;
    let last = live(&ws, "notes");
    assert!([&id, &rewritten["id"], &other["id"]].iter().all(|earlier| last["id"] != **earlier), "{last}");
    assert_eq!(last["version"], 5);
}

#[tokio::test]
async fn a_key_whose_history_went_before_the_upgrade_continues_above_its_seen_version() {
    let (_dir, ws, project) = lab();
    let live = |ws: &Workspace, key: &str| {
        home::build(&ws.store).unwrap()["projects"][0]["brief"]["sections"].as_array().unwrap().iter()
            .find(|s| s["key"] == key).cloned().unwrap_or(Value::Null)
    };
    for (n, request) in ["a1", "a2", "a3"].into_iter().enumerate() {
        accept(&ws, "a", input(request, n as i64, vec![put("notes", "report")])).await;
    }
    sections::mark_seen(&ws.store, &project, &[("notes".into(), 3)]).unwrap();
    // As an older Core leaves it: history expired, the seen version kept,
    // no endings yet. Then this Core's migration runs.
    {
        let writer = ws.store.db.write().unwrap();
        writer.execute_batch("DELETE FROM project_brief_sections WHERE key='notes'; DROP TABLE project_brief_endings;").unwrap();
        migrate(&writer).unwrap();
    }
    assert_eq!(rows(&ws, "SELECT COUNT(*) FROM project_brief_endings"), 0, "nothing to fill in from");
    assert_eq!(rows(&ws, "SELECT version FROM project_brief_seen WHERE key='notes'"), 3);
    accept(&ws, "a", input("a4", 3, vec![put("notes", "report")])).await;
    let again = live(&ws, "notes");
    assert_eq!((again["version"].clone(), again["seen"]["version"].clone()), (json!(4), json!(3)), "{again}");
    assert_eq!(home::build(&ws.store).unwrap()["projects"][0]["unseen"], 1, "new content is not taken for the version seen");
}

/// T-154: keys reads an index of every section without its body, and the
/// named sections in full beside it; without keys, every section as before.
#[tokio::test]
async fn keys_read_an_index_without_bodies_or_only_the_named_sections() {
    let (_dir, ws, _project) = lab();
    accept(&ws, "a", input("a1", 0, vec![put("plan", "report"), put("state", "status"), put("decide", "ask")])).await;
    let read = |input: Value| get(&ws.store, Some("b"), &input);
    let index = read(json!({"keys":[]})).unwrap();
    assert_eq!((index["sections"].clone(), index["missingKeys"].clone(), index["version"].clone()), (json!([]), json!([]), json!(1)));
    let entries = index["index"].as_array().unwrap();
    assert_eq!(entries.iter().map(|e| e["key"].clone()).collect::<Vec<_>>(), [json!("plan"), json!("state"), json!("decide")]);
    assert!(entries.iter().all(|e| e.get("body").is_none() && e.get("attachments").is_none() && e.get("refs").is_none()));
    assert_eq!((entries[0]["title"].clone(), entries[0]["owner"]["agentId"].clone()), (json!("About plan"), json!("a")));
    assert_eq!(entries[1]["status"]["stale"], false);
    assert_eq!(entries[2]["ask"]["state"], "open");
    assert_eq!(index["you"]["capabilities"]["editContent"], true);
    let named = read(json!({"keys":["plan","nope"]})).unwrap();
    assert_eq!(named["sections"].as_array().unwrap().len(), 1);
    assert_eq!(named["sections"][0]["body"], body("Hello"));
    assert_eq!((named["missingKeys"].clone(), named["index"].as_array().unwrap().len()), (json!(["nope"]), 3));
    let all = read(json!({})).unwrap();
    assert_eq!(all["sections"].as_array().unwrap().len(), 3);
    assert!(all.get("index").is_none() && all.get("missingKeys").is_none());
    let too_many: Vec<String> = (0..61).map(|n| format!("k{n}")).collect();
    for bad in [json!({"keys":"plan"}), json!({"keys":[1]}), json!({"keys":[""]}), json!({"keys":too_many}), json!({"fields":["plan"]})] {
        assert!(read(bad.clone()).unwrap_err().to_string().starts_with("invalid_input"), "{bad}");
    }
}

/// T-154: an editor owes no update and is told where outcomes go. Nothing is
/// resolved or refreshed for it: an authorized action may still be running,
/// and a stale status waits for new facts. Ask-only members get no advice.
#[tokio::test]
async fn editors_get_advice_never_a_duty_and_nothing_is_resolved_or_refreshed_for_them() {
    let (_dir, ws, project) = lab();
    let mut old = put("state", "status");
    old["status"] = json!({"asOf":"2026-01-01T00:00:00Z","validFor":60});
    accept(&ws, "a", input("a1", 0, vec![old, put("decide", "ask")])).await;
    assert!(sections::mark_replied(&ws.store, &project, "decide", "Left: go").unwrap());
    let before = version(&ws, &project);
    assert_eq!(agent_must_update_brief(&ws.store, "a").unwrap(), None);
    let you = brief(&ws, "a")["you"].clone();
    assert_eq!(you["capabilities"]["requiresTurnUpdate"], false);
    assert_eq!((you["homeHint"].clone(), you["staleStatus"].clone()), (json!(outcome_hint()), json!(["state"])));
    assert_eq!(you["repliedAsks"][0]["key"], "decide");
    let read = brief(&ws, "a");
    assert_eq!(section(&read, "decide")["ask"]["state"], "replied");
    assert_eq!(section(&read, "state")["status"], json!({"asOf":"2026-01-01T00:00:00Z","validFor":60,"stale":true}));
    assert_eq!(version(&ws, &project), before, "reading changed nothing");
    editors::save(&ws.store, &project, 0, Some(vec!["a".into()])).unwrap();
    let ask_only = brief(&ws, "b")["you"].clone();
    assert_eq!(ask_only["capabilities"]["editContent"], false);
    assert!(ask_only.get("homeHint").is_none());
}

/// T-154: a task result tells its author, and the Agent it reaches, where an
/// outcome goes on Home, only while each may edit that task's Project Brief.
#[tokio::test]
async fn a_task_result_carries_home_advice_only_for_editors_of_its_project() {
    let (_dir, ws, project) = lab();
    let call = |actor: &str, op: &str, input: Value| ws.store.collaboration_call(Some(actor), op, input).unwrap();
    let deliver = |request: &str, project: Value| {
        let task = call("a", "task_create", json!({"requestId":format!("{request}-c"),"title":"Measure","projectId":project}))["task"].clone();
        let sent = call("a", "task_dispatch", json!({"requestId":format!("{request}-d"),"taskId":task["id"],
            "expectedVersion":task["version"],"toAgentId":"b"}));
        call("b", "task_submit_result", json!({"requestId":format!("{request}-s"),"taskId":task["id"],
            "expectedVersion":sent["task"]["version"],"dispatchId":sent["message"]["dispatchId"],"summary":"Found it."}))
    };
    let mail = |submitted: &Value| submitted["message"]["body"].as_str().unwrap().to_owned();
    let both = deliver("both", json!(project));
    assert_eq!(both["homeHint"], outcome_hint());
    assert!(mail(&both).ends_with(outcome_hint()), "{}", mail(&both));
    // A task outside any Project: no Brief to keep, no advice.
    let none = deliver("none", Value::Null);
    assert!(none.get("homeHint").is_none() && !mail(&none).contains(outcome_hint()));
    // The user made b Ask-only: its result has no advice; a still gets it.
    editors::save(&ws.store, &project, 0, Some(vec!["a".into()])).unwrap();
    let ask_only = deliver("ask-only", json!(project));
    assert!(ask_only.get("homeHint").is_none());
    assert!(mail(&ask_only).ends_with(outcome_hint()));
}

/// Review a490d813: the Home hint is advice. When its lookup fails, a task
/// result is still submitted and mailed, without the hint; the result's own
/// version and assignment checks still refuse what they refused before.
#[tokio::test]
async fn a_failed_home_hint_lookup_never_fails_a_task_result() {
    let (_dir, ws, project) = lab();
    let call = |actor: &str, op: &str, input: Value| ws.store.collaboration_call(Some(actor), op, input);
    let task = call("a", "task_create", json!({"requestId":"c","title":"Measure","projectId":project})).unwrap()["task"].clone();
    let sent = call("a", "task_dispatch", json!({"requestId":"d","taskId":task["id"],"expectedVersion":task["version"],"toAgentId":"b"})).unwrap();
    // An editor policy Core cannot read: every hint lookup for this Project fails.
    ws.store.db.write().unwrap().execute(
        "INSERT OR REPLACE INTO project_brief_editors(project_id,version,editor_ids) VALUES(?1,1,'not json')", [&project]).unwrap();
    let id = task["id"].as_str().unwrap();
    // home_hint takes the task's own key, as task_submit_result passes it.
    let key: String = ws.store.db.read().unwrap()
        .query_row("SELECT task_id FROM project_tasks WHERE project_id=?1", [&project], |r| r.get(0)).unwrap();
    assert!(home_hint(&ws.store, &ws.store.db.read().unwrap(), &key, "b").is_err());
    let submit = |actor: &str, request: &str, version: &Value| call(actor, "task_submit_result", json!({"requestId":request,
        "taskId":id,"expectedVersion":version,"dispatchId":sent["message"]["dispatchId"],"summary":"Found it."}));
    let version = sent["task"]["version"].clone();
    assert!(submit("b", "stale", &json!(1)).unwrap_err().to_string().starts_with("version_conflict"));
    assert!(submit("c", "not-the-executor", &version).is_err());
    let submitted = submit("b", "s", &version).unwrap();
    assert!(submitted.get("homeHint").is_none());
    assert_eq!(submitted["task"]["status"], "review");
    let mail = submitted["message"]["body"].as_str().unwrap();
    assert!(mail.contains("submitted a result") && !mail.contains(outcome_hint()), "{mail}");
    let inbox = call("a", "peer_read", json!({})).unwrap();
    assert!(inbox["messages"].as_array().unwrap().iter().any(|m| m["metadata"]["kind"] == "task_result"));
}

/// T-175: the user's Home presentation preference is kept in the Workspace's
/// database (another connection to the file reads it), and each editor
/// gets it, labelled as the user's, wherever the Home hint goes: brief_get,
/// its own task result and the mail that result sends. Ask-only members get
/// neither. The default removes it, and with it every homePreference.
#[tokio::test]
async fn the_users_presentation_preference_reaches_editors_until_the_default_removes_it() {
    use presentation::{Presentation, Style};
    use tower::ServiceExt;
    let (dir, ws, project) = lab();
    let app = router().with_state(ws.clone());
    let send = |method: &str, body: Option<Value>| {
        let request = axum::http::Request::builder().method(method).uri("/api/home/presentation")
            .header("content-type", "application/json")
            .body(body.map_or_else(axum::body::Body::empty, |b| axum::body::Body::from(b.to_string()))).unwrap();
        let app = app.clone();
        async move {
            let response = app.oneshot(request).await.unwrap();
            let status = response.status();
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
            (status, serde_json::from_slice::<Value>(&bytes).unwrap_or(Value::Null))
        }
    };
    // Nothing set: the old answers, nothing new.
    let (status, unset) = send("GET", None).await;
    assert_eq!((status.as_u16(), unset["style"].clone(), unset["agentText"].clone(), unset["scope"].clone()),
        (200, json!("default"), Value::Null, json!("workspace")));
    assert!(brief(&ws, "a")["you"].get("homePreference").is_none());

    let (status, saved) = send("PUT", Some(json!({"style":"visual","note":"  Charts   before\n prose. "}))).await;
    assert_eq!((status.as_u16(), saved["note"].clone()), (200, json!("Charts before prose.")));
    let text = saved["agentText"].as_str().unwrap().to_owned();
    assert!(text.starts_with("The user's Home presentation preference, which the user set for this Workspace: lead with a visual summary"), "{text}");
    assert!(text.contains("In the user's words: \"Charts before prose.\"") && text.contains("exact figures, stated limits and risks, accessibility and the user's current instructions come first") && text.ends_with("changes no permission or Ask."), "{text}");
    assert!(saved["updatedAt"].is_string());
    for bad in [json!({"style":"bold"}), json!({"style":"visual","tone":"x"}), json!({"note":"x".repeat(301)})] {
        assert!(!send("PUT", Some(bad.clone())).await.0.is_success(), "{bad}");
    }
    assert_eq!(send("GET", None).await.1, saved, "a refused change leaves the saved one");

    let you = brief(&ws, "a")["you"].clone();
    assert_eq!((you["homeHint"].clone(), you["homePreference"].clone()), (json!(outcome_hint()), json!(text)));
    let call = |actor: &str, op: &str, input: Value| ws.store.collaboration_call(Some(actor), op, input).unwrap();
    let task = call("a", "task_create", json!({"requestId":"c","title":"Measure","projectId":project}))["task"].clone();
    let sent = call("a", "task_dispatch", json!({"requestId":"d","taskId":task["id"],"expectedVersion":task["version"],"toAgentId":"b"}));
    let submitted = call("b", "task_submit_result", json!({"requestId":"s","taskId":task["id"],
        "expectedVersion":sent["task"]["version"],"dispatchId":sent["message"]["dispatchId"],"summary":"Found it."}));
    assert_eq!(submitted["homePreference"], json!(text));
    let mail = submitted["message"]["body"].as_str().unwrap();
    assert!(mail.ends_with(&format!("{}\n{text}", outcome_hint())), "{mail}");

    // Kept in the Workspace's database, which Core reads each time: another
    // connection to the file, as after a restart, reads the same.
    let file = rusqlite::Connection::open(dir.path().join("data").join("workspace.sqlite")).unwrap();
    assert_eq!(presentation::view(&file).unwrap(), saved);
    drop(file);

    editors::save(&ws.store, &project, 0, Some(vec!["a".into()])).unwrap();
    assert!(brief(&ws, "b")["you"].get("homePreference").is_none(), "Ask-only: no advice");
    assert_eq!(brief(&ws, "a")["you"]["homePreference"], json!(text));

    // The user's words alone, without the visual sentence.
    let note_only = presentation::save(&ws.store, Presentation { style: Style::Default, note: "Short answers.".into() }).unwrap();
    let words = note_only["agentText"].as_str().unwrap();
    assert!(!words.contains("visual summary") && words.contains("\"Short answers.\""), "{words}");

    let (status, cleared) = send("PUT", Some(json!({"style":"default","note":""}))).await;
    assert_eq!((status.as_u16(), cleared["agentText"].clone(), cleared["updatedAt"].clone()), (200, Value::Null, Value::Null));
    assert!(brief(&ws, "a")["you"].get("homePreference").is_none());
    let count: i64 = ws.store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM workspace_meta WHERE key='home.presentation'", [], |r| r.get(0)).unwrap();
    assert_eq!(count, 0, "the default is no row at all");
}
