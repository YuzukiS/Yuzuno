//! /api/waits/live (YN-51): the reviews mailed to each Agent, and the
//! background work its harness reports, as the rail's ring reads them.
use super::*;
use crate::model::AgentDetail;
use rusqlite::params;
use std::collections::BTreeMap;

fn setup() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.insert(&serde_json::from_value::<AgentDetail>(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage",
        "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    s.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Fixture","status":"doing"})).unwrap();
    let task: String = s.db.read().unwrap().query_row("SELECT id FROM collaboration_tasks", [], |r| r.get(0)).unwrap();
    (dir, s, task)
}

/// A review round on PR `number`, mailed to `to` (an Agent's ID, or the user's).
fn review(s: &Store, task: &str, id: &str, status: &str, to: Value, number: u64, round: u64) {
    s.db.write().unwrap().execute("INSERT INTO pr_reviews(id,task_id,link_id,status,data) VALUES(?1,?2,?3,?4,?5)",
        params![id, task, format!("7:pull:{number}:{id}"), status,
            json!({"id":id,"status":status,"notificationRecipient":to,"number":number,"round":round}).to_string()]).unwrap();
}
fn agent(id: &str) -> Value {
    json!({"kind":"agent","id":id,"name":id})
}

#[test]
fn reviews_under_way_count_for_the_agent_they_are_mailed_to() {
    let (_dir, s, task) = setup();
    assert_eq!(s.live_reviews().unwrap(), Map::new());
    review(&s, &task, "r1", "preparing", agent("a"), 7, 1);
    review(&s, &task, "r2", "running", agent("a"), 9, 2);
    review(&s, &task, "r3", "completed", agent("a"), 11, 3);
    review(&s, &task, "r4", "failed", agent("a"), 12, 1);
    review(&s, &task, "r5", "running", agent("b"), 13, 1);
    review(&s, &task, "r6", "running", json!({"kind":"user","id":"user"}), 14, 1);
    let live = Value::Object(s.live_reviews().unwrap());
    // The newest under way names the PR and round; ended ones and the user's never count.
    assert_eq!(live, json!({"a":{"running":2,"pr":9,"round":2},"b":{"running":1,"pr":13,"round":1}}));
}

#[test]
fn only_agents_with_something_running_and_only_its_parts_are_listed() {
    let reviews = match json!({"a":{"running":1,"pr":9,"round":2}}) { Value::Object(m) => m, _ => unreachable!() };
    let background = BTreeMap::from([("a".to_string(), (0, 2)), ("b".to_string(), (1, 0)), ("c".to_string(), (0, 0))]);
    assert_eq!(waits(reviews, background), json!({"agents":{
        "a":{"reviews":{"running":1,"pr":9,"round":2},"subAgents":2},
        "b":{"shells":1}}}));
    assert_eq!(waits(Map::new(), BTreeMap::new()), json!({"agents":{}}));
}
