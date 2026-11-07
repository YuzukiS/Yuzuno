//! T-36: a queued Job of an executor being released is held, and refused,
//! saying so, once the release closes the executor.
use super::*;
use crate::{model::AgentDetail, store::Store};

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"e1","name":"Agent e1","cwd":"/workspace","model":"test","color":"sage",
        "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
    store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Memory checks","status":"doing"})).unwrap();
    store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,created_by,state,created_at,updated_at)
         VALUES('e1','executor','reviewer','agent:lead','dispatched','now','now')", []).unwrap();
    store.set_job_budget(Resources { cpu_millis: 4000, memory_mi_b: 4096, swap_mi_b: 0 }).unwrap();
    (dir, store)
}

fn queued(s: &Store, name: &str) -> Value {
    let request: Submit = serde_json::from_value(json!({"requestId":name,"taskId":"T-1","name":name,"cwd":"/workspace",
        "argv":["/usr/bin/true"],"resources":{"cpuMillis":500,"memoryMiB":512,"swapMiB":0}})).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":4096,"swapMiB":0}});
    s.create_job(Some("e1"), request, json!({"cwd":"/workspace"}), machine, json!({"bootId":"boot"})).unwrap()
}

#[test]
fn a_queued_job_of_an_executor_being_released_is_held_then_refused_saying_it_was_released() {
    let (_dir, s) = setup();
    let job = queued(&s, "later");
    assert!(crate::executor_archiving::begin(&s, "e1", "agent:lead").unwrap());
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none(), "held while its executor is being released");
    let held = s.job(job["id"].as_str().unwrap()).unwrap();
    assert_eq!((held["status"].as_str(), held["reason"].as_str()),
        (Some("queued"), Some("Held: its executor is being released; it is refused once the release closes it")));
    // The release closes and archives it.
    s.update("e1", "agent/closed", &json!({"reason":"released","by":"agent:lead"}), |d| d.agent.closed_at = Some(crate::model::now())).unwrap();
    s.db.write().unwrap().execute("UPDATE agent_roles SET archived_at='then',state='released' WHERE agent_id='e1'", []).unwrap();
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    let refused = s.job(job["id"].as_str().unwrap()).unwrap();
    assert_eq!(refused["status"], "rejected");
    assert_eq!(refused["reason"], "Its executor was released before launch: it starts nothing more; dispatch the task again for new work",
        "the refusal says it was released");
}
