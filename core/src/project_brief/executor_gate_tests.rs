use super::*;
use crate::collaboration_store::executor_overview::overview;
use crate::executor_lifecycle::tests::{role, task};
use rusqlite::params;

/// T-43 S4 (the user's option D, design/t43-gates): an executor asks for a
/// gate's approval with its own Home Ask, naming its task and the step.
/// Core takes it only from that task's executor and only for a gate step of
/// its template; the section and Home's Needs you say which gate; the
/// executor's Overview shows that step waiting for the ask, and nothing
/// after it begun, then done once the user answered.
#[tokio::test]
async fn an_executor_asks_for_its_gate_on_home_and_its_overview_waits_for_the_answer() {
    let (_dir, ws, project) = lab();
    set_leads(&ws, &project, &["a"]);
    let s = &ws.store;
    let (public, internal) = task(s, "Design first");
    let (_, other) = task(s, "Other work");
    role(s, "b", &internal, "user", "d1", "running", None);
    role(s, "c", &other, "user", "d2", "running", None);
    let steps = json!([{"kind":"materials"},{"kind":"work"},{"kind":"result"},{"kind":"gate","approver":"user"},{"kind":"work"},{"kind":"pr"}]);
    s.db.write().unwrap().execute(
        "INSERT INTO executor_dispatches(actor,request_id,input_json,task_id,template_id,project_id,machine_id,template_json,agent_id,state,created_at,updated_at)
         VALUES('user','r1','{}',?1,'design',?2,'local',?3,'b','dispatched','now','now')",
        params![internal, project, json!({"id":"design","label":"Design first","steps":steps}).to_string()],
    ).unwrap();
    // Its design note is in: the stage before the gate is over.
    s.db.write().unwrap().execute(
        "INSERT INTO collaboration_task_activity(task_id,data) VALUES(?1,?2)",
        params![internal, json!({"kind":"result","result":{"id":"note","dispatchId":"d1","reportedAt":"2026-11-07T10:00:00Z"}}).to_string()],
    ).unwrap();
    let gate = |task: &str, step: u64| {
        let mut change = put("gates/design", "ask");
        change["ask"]["gate"] = json!({"taskId":task,"step":step});
        change
    };

    // Another task's executor, a lead, and a step that is no gate: refused,
    // nothing written.
    let refused = reject(&ws, "c", input("c1", 0, vec![gate(&public, 3)])).await;
    assert_eq!(codes(&refused), ["gate_not_yours"]);
    assert_eq!(refused["problems"][0]["path"], "changes[0].ask.gate");
    assert_eq!(codes(&reject(&ws, "a", input("a1", 0, vec![gate(&public, 3)])).await), ["gate_not_yours"], "a lead is not its executor");
    let wrong = reject(&ws, "b", input("b1", 0, vec![gate(&public, 2)])).await;
    assert_eq!(codes(&wrong), ["gate_step_unknown"]);
    assert!(wrong["problems"][0]["reason"].as_str().unwrap().contains("gates are step 3"), "it says where its gates are: {wrong}");
    assert_eq!(version(&ws, &project), 0);

    // Its executor at its gate: accepted. The section and Needs you say which gate.
    accept(&ws, "b", input("b2", 0, vec![gate(&public, 3)])).await;
    assert_eq!(section(&brief(&ws, "a"), "gates/design")["ask"]["gate"], json!({"taskId":public,"step":3}));
    let home = home::build(s).unwrap();
    let item = home["needsYou"].as_array().unwrap().iter().find(|i| i["kind"] == "ask" && i["sectionKey"] == "gates/design").cloned();
    let item = item.expect("the gate's ask is in Needs you");
    assert_eq!((item["agentId"].clone(), item["gate"].clone()), (json!("b"), json!({"taskId":public,"step":3})));
    // An ask without a gate says none.
    accept(&ws, "a", input("a2", 1, vec![put("plain", "ask")])).await;
    assert!(section(&brief(&ws, "a"), "plain")["ask"].get("gate").is_none());
    let home = home::build(s).unwrap();
    let plain = home["needsYou"].as_array().unwrap().iter().find(|i| i["sectionKey"] == "plain").cloned().expect("listed");
    assert!(plain.get("gate").is_none(), "{plain}");

    // The Overview: the gate waits for its ask, and the work after it hasn't begun.
    let read = || overview(&ws.store.db.read().unwrap(), "b", false).unwrap().expect("an executor");
    let shown = read();
    let step = &shown["steps"][3];
    assert_eq!((step["kind"].clone(), step["state"].clone()), (json!("gate"), json!("blocked")));
    assert_eq!((step["ref"]["kind"].clone(), step["ref"]["projectId"].clone(), step["ref"]["key"].clone(), step["ref"]["state"].clone()),
        (json!("ask"), json!(project), json!("gates/design"), json!("open")));
    assert_eq!(shown["steps"][2]["state"], "done", "its design note is in");
    assert_eq!(shown["steps"][4]["state"], "todo", "nothing after the gate begun, though the stage before it is over");
    // Answered on Home: done. Its executor resolves it: still done.
    assert!(sections::mark_replied_live(&ws.store, &project, "gates/design", "Approve").unwrap());
    let answered = read();
    assert_eq!((answered["steps"][3]["state"].clone(), answered["steps"][3]["ref"]["state"].clone()), (json!("done"), json!("replied")));
    assert_eq!(answered["steps"][4]["state"], "doing", "the work after it is where it is now");
    accept(&ws, "b", input("b3", 2, vec![op("resolve", "gates/design")])).await;
    let resolved = read();
    assert_eq!((resolved["steps"][3]["state"].clone(), resolved["steps"][3]["ref"]["state"].clone()), (json!("done"), json!("resolved")));
    // Another executor's Overview has none of it.
    let others = overview(&ws.store.db.read().unwrap(), "c", false).unwrap().unwrap();
    assert!(others["steps"].as_array().unwrap().iter().all(|s| s["ref"]["kind"] != "ask"), "{others}");
}
