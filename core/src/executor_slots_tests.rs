use super::*;
use crate::model::AgentDetail;
use std::collections::BTreeMap;

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    (dir, store)
}

fn agent(store: &Store, id: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Executor {id}"),"cwd":"/synthetic/work",
        "model":"","harness":"claude","color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
}

/// Executor `id`, dispatched for the task `task-<id>`, waiting in the queue.
fn queued(store: &Store, id: &str, project: Option<&str>, machine: &str) {
    agent(store, id);
    enqueue(&store.db.write().unwrap(), id, &format!("task-{id}"), project, machine, "reviewer").unwrap();
}

/// Its row's state and reason; "none" without a row.
fn state(store: &Store, id: &str) -> (String, Option<String>) {
    store.db.read().unwrap()
        .query_row("SELECT state, reason FROM executor_slots WHERE agent_id=?1", [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .optional().unwrap().unwrap_or_else(|| ("none".into(), None))
}

fn close(store: &Store, id: &str) {
    store.update(id, "agent/closed", &json!({}), |d| d.agent.closed_at = Some(now())).unwrap();
}

fn connected(store: &Store, id: &str) {
    store.update(id, "runtime/connected", &json!({}), |d| d.agent.connection_state = "connected".into()).unwrap();
}

fn limit(store: &Store, key: &str, slots: i64) {
    let db = store.db.write().unwrap();
    let version = limit_at(&db, key).unwrap().version;
    save_limit(&db, key, version, Some(slots)).unwrap();
}

/// What the scheduler starts, pass after pass, until it starts none.
fn started(store: &Store) -> Vec<String> {
    std::iter::from_fn(|| store.executor_slot_next().unwrap()).collect()
}

fn view(store: &Store, task: &str) -> Option<Value> {
    views(&store.db.read().unwrap(), &[task]).unwrap().remove(task)
}

/// D1, D2: executors start while the Workspace has slots, in the order they
/// were dispatched; the rest wait, and only the queue starts them. Any close
/// frees a slot, and the next starts.
#[test]
fn the_workspace_limit_starts_executors_in_dispatch_order_and_a_close_frees_a_slot() {
    let (_dir, store) = store();
    limit(&store, KEY, 2);
    // Without a Project they take their turn as one: dispatch order, not their IDs'.
    for id in ["c", "b", "a", "d"] {
        queued(&store, id, None, "local");
    }
    assert_eq!(started(&store), ["c", "b"], "two slots: the first two dispatched start");
    assert_eq!(state(&store, "c"), ("starting".into(), None));
    assert_eq!(state(&store, "a"), ("waiting".into(), None));

    // A waiting executor cannot be started any other way, and is told its place.
    let refused = store.executor_slot_gate("d");
    assert!(refused.is_err(), "a waiting executor is not started any other way");
    let refused = refused.unwrap_err();
    assert!(refused.downcast_ref::<WaitsForSlot>().is_some(), "a typed refusal: not the executor's failure");
    assert_eq!(refused.to_string(), "executor_queued: this executor waits for an executor slot (number 2 in the queue); \
        it starts when one is free. To run more at once, raise Executors at once in Settings");
    store.executor_slot_gate("c").expect("one holding its slot may start");
    agent(&store, "standing");
    store.executor_slot_gate("standing").expect("an Agent that is not an executor may start");

    assert_eq!(view(&store, "task-a"), Some(json!({"agentId":"a","state":"waiting","machine":"local","position":1})));
    assert_eq!(view(&store, "task-c"), Some(json!({"agentId":"c","state":"starting","machine":"local"})));
    assert_eq!(view(&store, "task-standing"), None, "no executor, no slot");

    // Running, then disconnected: it keeps its slot.
    store.executor_slot_started("c").unwrap();
    assert_eq!(state(&store, "c"), ("running".into(), None));
    store.update("c", "runtime/disconnected", &json!({}), |d| d.agent.disconnected_at = Some(now())).unwrap();
    assert!(started(&store).is_empty(), "a disconnect keeps the slot");

    close(&store, "c");
    assert_eq!(started(&store), ["a"], "a close frees its slot for the next");
    assert_eq!(state(&store, "c"), ("released".into(), Some("closed".into())));
    assert_eq!(view(&store, "task-c"), None, "a closed executor shows no slot");
    assert_eq!(view(&store, "task-d"), Some(json!({"agentId":"d","state":"waiting","machine":"local","position":1})));

    // An Agent gone altogether frees its slot too.
    store.db.write().unwrap().execute("DELETE FROM agents WHERE id='b'", []).unwrap();
    assert_eq!(started(&store), ["d"]);
    assert_eq!(state(&store, "b"), ("released".into(), Some("closed".into())));
}

fn reopen(store: &Store, id: &str) {
    store.update(id, "agent/reopened", &json!({}), |d| {
        d.agent.closed_at = None;
        d.agent.connection_state = "disconnected".into();
    }).unwrap();
}

/// D1, D4: a close releases the slot in the transaction that closes the
/// executor, before any pass; a reopen queues it again, last, so a reopened
/// executor never runs past the limit. One from before slots gets its row.
#[test]
fn a_close_releases_the_slot_with_it_and_a_reopen_queues_the_executor_again() {
    let (_dir, store) = store();
    limit(&store, KEY, 1);
    queued(&store, "a", None, "local");
    queued(&store, "b", None, "local");
    assert_eq!(started(&store), ["a"]);
    assert!(!store.executor_slot_not_started("a", true, "its start was not confirmed").unwrap());
    close(&store, "a");
    assert_eq!(state(&store, "a"), ("released".into(), Some("closed".into())), "released with the close, before any pass");
    assert_eq!(started(&store), ["b"]);
    reopen(&store, "a");
    assert_eq!(state(&store, "a"), ("waiting".into(), None), "reopened: it waits again");
    assert_eq!(view(&store, "task-a").unwrap()["position"], 1);
    assert!(store.executor_slot_gate("a").is_err(), "and only the queue starts it");
    assert!(started(&store).is_empty(), "b holds the one slot");
    queued(&store, "c", None, "local");
    close(&store, "b");
    assert_eq!(started(&store), ["a"], "the reopened one, first in the queue");
    // Its start fails: a reopened executor stays open and keeps its slot,
    // as a failed reconnect leaves an Agent (R1 1ec1008a P3-2).
    assert!(!store.executor_slot_not_started("a", false, "the runtime refused it").unwrap(),
        "a reopened executor whose start fails is not closed");
    assert_eq!(state(&store, "a"), ("starting".into(), Some("the runtime refused it".into())), "it keeps its slot, with why");

    // An executor from before slots, closed then reopened, waits too.
    agent(&store, "older");
    store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,created_at,updated_at)
         VALUES('older','executor','reviewer','task-older','user','now','now')", []).unwrap();
    close(&store, "older");
    reopen(&store, "older");
    assert_eq!(state(&store, "older"), ("waiting".into(), None));
    let attempt: i64 = store.db.read().unwrap()
        .query_row("SELECT attempt FROM executor_slots WHERE agent_id='older'", [], |r| r.get(0)).unwrap();
    assert_eq!(attempt, 2, "it started before slots existed: a later start, not a fresh dispatch's");
    assert_eq!(view(&store, "task-older").unwrap()["position"], 2, "behind c");
    // A plain Agent reopened gets no row.
    agent(&store, "standing");
    close(&store, "standing");
    reopen(&store, "standing");
    store.executor_slot_gate("standing").unwrap();
}

/// D6: a Project's or a machine's own limit, when set, holds back only its
/// executors; the next in the queue with room starts instead.
#[test]
fn a_project_or_machine_at_its_own_limit_lets_the_next_in_the_queue_start() {
    let (_dir, store) = store();
    limit(&store, KEY, 4);
    limit(&store, &project_key("p1"), 1);
    limit(&store, &machine_key("m1"), 1);
    queued(&store, "a", Some("p1"), "local");
    queued(&store, "b", Some("p1"), "local");
    queued(&store, "c", Some("p2"), "m1");
    queued(&store, "d", Some("p2"), "m1");
    queued(&store, "e", Some("p2"), "local");
    assert_eq!(started(&store), ["a", "c", "e"], "b waits while p1 has its one; d while m1 has its one");
    assert_eq!((state(&store, "b").0.as_str(), state(&store, "d").0.as_str()), ("waiting", "waiting"));
    close(&store, "c");
    assert_eq!(started(&store), ["d"], "m1 has room again");
    close(&store, "a");
    assert_eq!(started(&store), ["b"], "p1 has room again");
    queued(&store, "f", Some("p3"), "local");
    queued(&store, "g", Some("p3"), "local");
    assert_eq!(started(&store), ["f"], "the Workspace's fourth slot");
    assert_eq!(state(&store, "g").0, "waiting", "the Workspace's four are held");
}

/// Projects take turns, as in the Jobs queue; one waiting past the aging
/// time goes first.
#[test]
fn projects_take_turns_and_one_waiting_longest_goes_first() {
    for aged in [false, true] {
        let (_dir, store) = store();
        limit(&store, KEY, 10);
        for id in ["x1", "x2", "x3"] {
            queued(&store, id, Some("p1"), "local");
        }
        queued(&store, "y1", Some("p2"), "local");
        if aged {
            let long_ago = (chrono::Utc::now() - chrono::Duration::seconds(queue::AGING_SECS + 60)).to_rfc3339();
            store.db.write().unwrap().execute("UPDATE executor_slots SET queued_at=?1 WHERE agent_id='x3'", [long_ago]).unwrap();
            assert_eq!(view(&store, "task-x3").unwrap()["position"], 1, "its place in the queue is the order it starts in");
            assert_eq!(started(&store), ["x3", "y1", "x1", "x2"], "the one waiting longest first, then Projects in turn");
        } else {
            assert_eq!(view(&store, "task-y1").unwrap()["position"], 2, "Projects in turn: y1 is second in the queue");
            assert_eq!(started(&store), ["x1", "y1", "x2", "x3"], "Projects in turn, each in dispatch order");
        }
    }
}

/// Past the Jobs queue's window the rest follow in dispatch order: each has
/// a place, and the scheduler reaches them when those before have no room.
#[test]
fn executors_past_the_queue_window_have_a_place_and_can_start() {
    let (_dir, store) = store();
    limit(&store, KEY, 64);
    limit(&store, &project_key("full"), 1);
    queued(&store, "holder", Some("full"), "local");
    assert_eq!(started(&store), ["holder"]);
    for i in 0..queue::WINDOW {
        queued(&store, &format!("full-{i:02}"), Some("full"), "local");
    }
    queued(&store, "beyond", Some("open"), "local");
    // The full Project's have waited past the aging time: they fill the window.
    let long_ago = (chrono::Utc::now() - chrono::Duration::seconds(queue::AGING_SECS + 60)).to_rfc3339();
    store.db.write().unwrap().execute("UPDATE executor_slots SET queued_at=?1 WHERE agent_id LIKE 'full-%'", [long_ago]).unwrap();
    assert_eq!(view(&store, "task-beyond").unwrap()["position"], queue::WINDOW + 1);
    assert_eq!(started(&store), ["beyond"], "the one past the window starts: those before it have no room");
}

/// S1's start failures: a refused start frees the slot (its executor is
/// closed by the caller); one that may be running keeps it as starting, with
/// why, until it connects or is closed.
#[test]
fn a_refused_start_frees_its_slot_and_one_that_may_be_running_keeps_it() {
    let (_dir, store) = store();
    limit(&store, KEY, 1);
    for id in ["a", "b", "c"] {
        queued(&store, id, None, "local");
    }
    assert_eq!(started(&store), ["a"]);
    assert!(store.executor_slot_not_started("a", false, "the runtime refused it").unwrap(), "a fresh dispatch's start: closed");
    assert_eq!(state(&store, "a"), ("released".into(), Some("the runtime refused it".into())));
    assert_eq!(started(&store), ["b"]);
    assert!(!store.executor_slot_not_started("b", true, "its start was not confirmed").unwrap(), "it may be running: kept open");
    assert_eq!(state(&store, "b"), ("starting".into(), Some("its start was not confirmed".into())));
    assert!(started(&store).is_empty(), "it keeps its slot");
    assert!(!store.executor_slot_not_started("c", false, "not starting").unwrap());
    assert_eq!(state(&store, "c").0, "waiting", "only a starting slot is ended");
    connected(&store, "b");
    assert!(started(&store).is_empty());
    assert_eq!(state(&store, "b"), ("running".into(), None), "connected: running");
}

/// D1, D5: at startup a start left unfinished waits again, unless it may be
/// running; executors open from before slots existed hold one, running.
#[test]
fn a_restart_queues_unfinished_starts_again_and_counts_executors_from_before() {
    let (dir, store) = store();
    limit(&store, KEY, 3);
    for id in ["unfinished", "unknown", "running", "behind"] {
        queued(&store, id, None, "local");
    }
    assert_eq!(started(&store), ["unfinished", "unknown", "running"]);
    assert!(!store.executor_slot_not_started("unknown", true, "its start was not confirmed").unwrap());
    store.executor_slot_started("running").unwrap();
    let role = |id: &str| {
        agent(&store, id);
        store.db.write().unwrap().execute(
            "INSERT INTO agent_roles(agent_id,kind,template_id,task_id,created_by,state,created_at,updated_at)
             VALUES(?1,'executor','reviewer','task-older','user','created','now','now')", [id]).unwrap();
    };
    role("older");
    role("older-closed");
    close(&store, "older-closed");
    agent(&store, "remote-older");
    store.update("remote-older", "agent/remote", &json!({}), |d| {
        d.agent.remote = Some(serde_json::from_value(json!({"machine":{"id":"m1","name":"Synthetic Machine",
            "target":"synthetic-host","codex":"codex","defaultCwd":"/synthetic/work"}})).unwrap());
    }).unwrap();
    store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,created_by,created_at,updated_at)
         VALUES('remote-older','executor','reviewer','user','now','now')", []).unwrap();
    drop(store);

    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    store.recover_executor_slots().unwrap();
    assert_eq!(state(&store, "unfinished"), ("waiting".into(), None), "no runtime outlives Core: it waits again");
    assert_eq!(state(&store, "unknown"), ("starting".into(), Some("its start was not confirmed".into())));
    assert_eq!(state(&store, "running"), ("running".into(), None));
    assert_eq!(state(&store, "older"), ("running".into(), None), "one open from before holds a slot");
    let machine: String = store.db.read().unwrap()
        .query_row("SELECT machine_id FROM executor_slots WHERE agent_id='remote-older'", [], |r| r.get(0)).unwrap();
    assert_eq!(machine, "m1", "on its machine");
    let closed: i64 = store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM executor_slots WHERE agent_id='older-closed'", [], |r| r.get(0)).unwrap();
    assert_eq!(closed, 0, "a closed one holds none");
    store.recover_executor_slots().unwrap();
    assert_eq!(state(&store, "older"), ("running".into(), None), "a second recovery changes nothing");
    // Four hold slots now (unknown, running, older, remote-older; unfinished waits): past three, none starts.
    assert!(started(&store).is_empty());
    assert_eq!(state(&store, "behind").0, "waiting");
}

/// D9: the limits as Settings saves them: each a version it is saved
/// against, a whole number from 1 to 64; a Project's may be unset.
#[test]
fn executor_slot_limits_are_saved_against_their_version_within_their_range() {
    let (_dir, store) = store();
    let view = store.executor_slots_view(None).unwrap();
    assert_eq!(view["workspace"], json!({"version":0,"slots":DEFAULT_SLOTS,"saved":false,"default":DEFAULT_SLOTS}));
    assert_eq!(view["limits"], json!({"min":1,"max":MAX_SLOTS}));
    assert_eq!(view.get("project"), None);
    store.save_executor_slots(None, 0, Some(5)).unwrap();
    assert_eq!(store.executor_slots_view(None).unwrap()["workspace"], json!({"version":1,"slots":5,"saved":true,"default":3}));
    let error = |result: Result<()>| result.unwrap_err().to_string();
    assert_eq!(error(store.save_executor_slots(None, 0, Some(6))), "version_conflict: these executor slots changed; reload before saving");
    for bad in [0, MAX_SLOTS + 1] {
        assert_eq!(error(store.save_executor_slots(None, 1, Some(bad))), "invalid_input: executors at once is a whole number from 1 to 64");
    }
    assert!(error(store.save_executor_slots(None, 1, None)).starts_with("invalid_input: the Workspace's executors at once"));

    let project = store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/project".into())])).unwrap().id;
    assert_eq!(store.executor_slots_view(Some(&project)).unwrap()["project"], json!({"id":project,"version":0,"slots":null}));
    store.save_executor_slots(Some(&project), 0, Some(2)).unwrap();
    assert_eq!(store.executor_slots_view(Some(&project)).unwrap()["project"], json!({"id":project,"version":1,"slots":2}));
    store.save_executor_slots(Some(&project), 1, None).unwrap();
    assert_eq!(store.executor_slots_view(Some(&project)).unwrap()["project"], json!({"id":project,"version":2,"slots":null}),
        "unset: only the Workspace's applies");
    assert!(store.executor_slots_view(Some("no-such-project")).is_err());
    assert!(store.save_executor_slots(Some("no-such-project"), 0, Some(1)).is_err());

    // A value this Core can't use reads as unset, and is saved over by its version.
    store.db.write().unwrap().execute("UPDATE workspace_meta SET value='{\"version\":4,\"slots\":900}' WHERE key=?1", [KEY]).unwrap();
    assert_eq!(store.executor_slots_view(None).unwrap()["workspace"], json!({"version":4,"slots":3,"saved":false,"default":3}));
    store.save_executor_slots(None, 4, Some(2)).unwrap();

    queued(&store, "a", None, "local");
    queued(&store, "b", None, "local");
    queued(&store, "c", None, "local");
    assert_eq!(started(&store), ["a", "b"], "the saved Workspace limit holds");
    store.executor_slot_started("a").unwrap();
    assert_eq!(store.executor_slots_view(None).unwrap()["inUse"], json!({"waiting":1,"starting":1,"running":1}));
}

/// The routes take whole numbers only; null leaves a Project's unset.
#[test]
fn a_saved_limit_is_a_whole_number_or_null() {
    let save = |slots: Option<Value>| slots_of(&Save { expected_version: 0, slots }).map_err(|e| e.to_string());
    assert_eq!(save(Some(json!(4))), Ok(Some(4)));
    assert_eq!(save(Some(json!(64))), Ok(Some(64)));
    assert_eq!(save(Some(Value::Null)), Ok(None));
    assert_eq!(save(None), Ok(None));
    for bad in [json!(0), json!(65), json!(2.5), json!("2"), json!(-1), json!(true)] {
        assert_eq!(save(Some(bad.clone())), Err("invalid_input: executors at once is a whole number from 1 to 64".into()), "{bad}");
    }
}
