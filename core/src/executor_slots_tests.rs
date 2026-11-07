use super::*;
use crate::model::AgentDetail;
use std::collections::BTreeMap;

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    (dir, store)
}

fn agent(store: &Store, id: &str) {
    agent_of(store, id, "claude");
}

fn agent_of(store: &Store, id: &str, harness: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Executor {id}"),"cwd":"/synthetic/work",
        "model":"","harness":harness,"color":"sage","status":"offline","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
}

/// Executor `id`, dispatched for the task `task-<id>`, waiting in the queue.
fn queued(store: &Store, id: &str, project: Option<&str>, machine: &str) {
    agent(store, id);
    enqueue(&store.db.write().unwrap(), id, &format!("task-{id}"), project, machine, "reviewer").unwrap();
}

/// As `queued` on this host, made from the template `template` (its id).
fn queued_from(store: &Store, id: &str, project: Option<&str>, template: &str) {
    agent(store, id);
    enqueue(&store.db.write().unwrap(), id, &format!("task-{id}"), project, "local", template).unwrap();
}

/// A template list as a save leaves it: the Workspace's, or a Project's own.
fn templates(store: &Store, project: Option<&str>, list: Value) {
    let key = project.map_or_else(|| "executors.templates".to_owned(), crate::executor_templates::project_key);
    store.db.write().unwrap().execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, json!({"version":1,"templates":list}).to_string()]).unwrap();
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
    save_limit(&db, key, version, Some(slots), None).unwrap();
}

/// What the scheduler starts, pass after pass, until it starts none.
fn started(store: &Store) -> Vec<String> {
    std::iter::from_fn(|| store.executor_slot_next(&Default::default()).unwrap()).collect()
}

fn view(store: &Store, task: &str) -> Option<Value> {
    views(&store.db.read().unwrap(), &[task]).unwrap().remove(task)
}

/// D1, D2: executors start while their machine has slots (YN-2 S5: its
/// limit is the only one), in the order they were dispatched; the rest wait,
/// and only the queue starts them. Any close frees a slot, and the next starts.
#[test]
fn a_machines_limit_starts_executors_in_dispatch_order_and_a_close_frees_a_slot() {
    let (_dir, store) = store();
    limit(&store, &machine_key("local"), 2);
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
    assert_eq!(refused.to_string(), "executor_queued: this executor waits for a slot on this Core host (2 of 2 running there; \
        number 2 in the queue); it starts when one is free. To run more at once there, raise that machine's Executors at once in Settings → Machines");
    store.executor_slot_gate("c").expect("one holding its slot may start");
    agent(&store, "standing");
    store.executor_slot_gate("standing").expect("an Agent that is not an executor may start");

    let waits = |running: i64| json!({"machine":"local","name":"this Core host","running":running,"limit":2});
    assert_eq!(view(&store, "task-a"), Some(json!({"agentId":"a","state":"waiting","machine":"local","position":1,"waitsFor":waits(2)})));
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
    assert_eq!(view(&store, "task-d"), Some(json!({"agentId":"d","state":"waiting","machine":"local","position":1,"waitsFor":waits(2)})));

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
    limit(&store, &machine_key("local"), 1);
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

/// One scheduler pass, waited for until each start it began has ended.
async fn pass(ws: &Arc<Workspace>) {
    for started in ws.executor_slots_pass().await {
        started.await.unwrap();
    }
}

/// R1 1ec1008a P3-2, through the scheduler: a fresh dispatch's start the
/// runtime refused closes its executor and frees its slot; a reopened
/// executor's stays open and retryable, holding its slot with the reason the
/// task shows, as a failed reconnect leaves an Agent.
#[tokio::test]
async fn a_reopened_executor_whose_start_fails_stays_open_with_its_slot_and_a_fresh_one_is_closed() {
    let dir = tempfile::tempdir().unwrap();
    // A Codex that can't start: every runtime start is refused.
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(),
        dir.path().join("no-codex").to_string_lossy().into()).unwrap();
    limit(&ws.store, &machine_key("local"), 1);
    agent_of(&ws.store, "fresh", "codex");
    enqueue(&ws.store.db.write().unwrap(), "fresh", "task-fresh", None, "local", "reviewer").unwrap();
    pass(&ws).await;
    assert!(ws.store.agent("fresh").unwrap().closed_at.is_some(), "a fresh dispatch whose start was refused is closed");
    assert_eq!(state(&ws.store, "fresh").0, "released", "and frees its slot");

    // Dispatched, closed before it started, and reopened: its next start is a later one.
    agent_of(&ws.store, "again", "codex");
    enqueue(&ws.store.db.write().unwrap(), "again", "task-again", None, "local", "reviewer").unwrap();
    close(&ws.store, "again");
    reopen(&ws.store, "again");
    pass(&ws).await;
    let again = ws.store.agent("again").unwrap();
    assert!(again.closed_at.is_none(), "a reopened executor whose start fails stays open");
    let (held, reason) = state(&ws.store, "again");
    assert_eq!(held, "starting", "it keeps its slot");
    let reason = reason.expect("with the reason");
    assert!(!reason.is_empty());
    assert_eq!(view(&ws.store, "task-again").unwrap()["reason"], json!(reason), "the task shows why");
    ws.store.executor_slot_gate("again").expect("retryable: the user's Connect may start it");
    agent_of(&ws.store, "next", "codex");
    enqueue(&ws.store.db.write().unwrap(), "next", "task-next", None, "local", "reviewer").unwrap();
    pass(&ws).await;
    assert_eq!(state(&ws.store, "next").0, "waiting", "its slot stays held: the next waits");
}

/// YN-2 S5: only a machine's limit holds an executor back. The Workspace's
/// number and a Project's from before hold nothing; a full machine holds
/// back none bound for another, and a close there makes room there.
#[test]
fn only_the_machines_limit_holds_an_executor() {
    let (_dir, store) = store();
    limit(&store, KEY, 1);
    limit(&store, "executors.slots.project:p1", 1);
    limit(&store, &machine_key("local"), 2);
    limit(&store, &machine_key("m1"), 1);
    queued(&store, "a", Some("p1"), "local");
    queued(&store, "b", Some("p1"), "local");
    queued(&store, "c", Some("p2"), "m1");
    queued(&store, "d", Some("p2"), "m1");
    queued(&store, "e", Some("p2"), "local");
    let mut first = started(&store);
    first.sort();
    assert_eq!(first, ["a", "b", "c"],
        "only the machines' limits hold: this Core host takes 2 and m1 1; the Workspace's 1 and p1's 1 from before hold nothing");
    assert_eq!((state(&store, "d").0.as_str(), state(&store, "e").0.as_str()), ("waiting", "waiting"));
    close(&store, "c");
    assert_eq!(started(&store), ["d"], "m1 has room again");
    close(&store, "a");
    assert_eq!(started(&store), ["e"], "this Core host has room again");
}

/// YN-2 S5: a template's `maxConcurrent` from before holds nothing, a
/// Project's own list's neither; only the machine's limit does.
#[test]
fn project_and_template_limits_hold_nothing() {
    let (_dir, store) = store();
    limit(&store, &machine_key("local"), 10);
    templates(&store, None, json!([{"id":"reviewer","label":"Reviewer","harness":"claude","maxConcurrent":1}]));
    templates(&store, Some("p1"), json!([{"id":"reviewer","label":"P1 reviewer","harness":"claude","maxConcurrent":1}]));
    limit(&store, "executors.slots.project:p1", 1);
    queued_from(&store, "a", None, "reviewer");
    queued_from(&store, "b", None, "reviewer");
    queued_from(&store, "c", Some("p1"), "reviewer");
    queued_from(&store, "d", Some("p1"), "reviewer");
    let mut all = started(&store);
    all.sort();
    assert_eq!(all, ["a", "b", "c", "d"], "a template's or a Project's limit from before holds nothing");
}

/// YN-2 S5: a machine with no limit saved runs the default, 3; every machine
/// has a limit, and the Workspace's number from before is no cap.
#[test]
fn a_machine_with_no_limit_saved_runs_the_default() {
    let (_dir, store) = store();
    limit(&store, KEY, 10);
    for i in 0..4 {
        queued(&store, &format!("l{i}"), None, "local");
        queued(&store, &format!("m{i}"), None, "m2");
    }
    let all = started(&store);
    let on = |prefix: &str| all.iter().filter(|id| id.starts_with(prefix)).count();
    assert_eq!((on("l"), on("m")), (3, 3), "each machine with no limit saved runs the default 3, not the Workspace's 10: {all:?}");
}

/// YN-2 S5, at the first open: the Workspace's saved number becomes this Core
/// host's own when it has none; a machine's saved limit stays, also above
/// it; a registered machine with none runs the default and is listed; the
/// marker records it all, and a second open writes nothing.
#[test]
fn at_open_the_workspace_number_becomes_the_core_hosts_limit_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.db");
    {
        let store = Store::open(&path).unwrap();
        for (id, name) in [("big-box", "Big box"), ("quiet-box", "Quiet box")] {
            store.add_machine(&crate::remote::RemoteMachine {
                id: id.into(), name: name.into(), target: format!("tester@{id}.invalid"), ..Default::default()
            }).unwrap();
        }
        limit(&store, KEY, 6);
        limit(&store, &machine_key("big-box"), 10);
        limit(&store, "executors.slots.project:p1", 2);
        // As a Workspace from before this Core was: no record of the change.
        store.db.write().unwrap().execute("DELETE FROM workspace_meta WHERE key='executors.slots.machines'", []).unwrap();
    }
    let store = Store::open(&path).unwrap();
    let own = |machine: &str| limit_at(&store.db.read().unwrap(), &machine_key(machine)).unwrap();
    assert_eq!(own("local").slots, Some(6), "the Workspace's number becomes this Core host's own");
    assert_eq!(own("big-box").slots, Some(10), "a machine's saved limit stays, above the old total too");
    assert_eq!(own("quiet-box").slots, None, "a registered machine with none runs the default");
    assert_eq!(limit_at(&store.db.read().unwrap(), KEY).unwrap().slots, Some(6), "the Workspace record stays, for older Cores");
    let raw: String = store.db.read().unwrap()
        .query_row("SELECT value FROM workspace_meta WHERE key='executors.slots.machines'", [], |r| r.get(0)).unwrap();
    let record: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!((record["workspaceSlots"].clone(), record["coreHost"].clone(), record["machines"].clone(), record["defaulted"].clone(),
        record["ignoredProjectLimits"].clone()),
        (json!(6), json!({"before":null,"after":6}), json!({"local":6,"big-box":10,"quiet-box":3}), json!(["quiet-box"]), json!({"p1":2})),
        "what the first open did: {record}");
    let version = own("local").version;
    drop(store);
    let store = Store::open(&path).unwrap();
    assert_eq!(limit_at(&store.db.read().unwrap(), &machine_key("local")).unwrap().version, version, "a second open writes nothing");
}

/// YN-2 S5: a waiting executor says the machine it waits for and how full
/// that is, in its task's executorSlot and in the refusal to start it by hand.
#[test]
fn a_waiting_executor_says_which_machine_it_waits_for() {
    let (_dir, store) = store();
    limit(&store, &machine_key("local"), 1);
    queued(&store, "a", None, "local");
    queued(&store, "b", None, "local");
    assert_eq!(started(&store), ["a"]);
    assert_eq!(view(&store, "task-b").unwrap()["waitsFor"], json!({"machine":"local","name":"this Core host","running":1,"limit":1}),
        "the machine it waits for, and how full it is");
    let refused = store.executor_slot_gate("b").unwrap_err().to_string();
    assert!(refused.starts_with("executor_queued: this executor waits for a slot on this Core host (1 of 1 running there; number 1 in the queue)"),
        "{refused}");
}

/// Projects take turns, as in the Jobs queue; one waiting past the aging
/// time goes first.
#[test]
fn projects_take_turns_and_one_waiting_longest_goes_first() {
    for aged in [false, true] {
        let (_dir, store) = store();
        limit(&store, &machine_key("local"), 10);
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
    limit(&store, &machine_key("local"), 64);
    limit(&store, &machine_key("full-box"), 1);
    queued(&store, "holder", Some("full"), "full-box");
    assert_eq!(started(&store), ["holder"]);
    for i in 0..queue::WINDOW {
        queued(&store, &format!("full-{i:02}"), Some("full"), "full-box");
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
    limit(&store, &machine_key("local"), 1);
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
    limit(&store, &machine_key("local"), 3);
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
    // Three hold this Core host's slots (unknown, running, older; remote-older is m1's): at its three, none more starts.
    assert!(started(&store).is_empty());
    assert_eq!(state(&store, "behind").0, "waiting");
}

/// A PUT to `path` through the slots routes, as the browser sends it.
async fn put_route(ws: &Arc<Workspace>, path: &str, body: Value) -> (axum::http::StatusCode, Value) {
    use tower::ServiceExt;
    let request = axum::http::Request::builder().method("PUT").uri(path).header("content-type", "application/json")
        .body(axum::body::Body::from(body.to_string())).unwrap();
    let response = router().with_state(ws.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
    (status, serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null))
}

/// YN-2 S5: the Workspace's and a Project's numbers are no longer set: a
/// save naming one is refused, saying where it is now, and changes nothing.
/// The Workspace's start time limit still saves, against its version, and
/// keeps the number older Cores read. The view lists each machine's limit
/// and their sum.
#[tokio::test]
async fn the_workspace_and_project_slot_saves_are_refused_and_the_start_limit_still_saves() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    limit(&ws.store, KEY, 5);
    let project = ws.store.create_project("Lab", BTreeMap::from([("local".into(), "/synthetic/project".into())])).unwrap().id;
    let removed = "setting_removed: executors at once is each machine's; set it in Settings → Machines";
    for (path, body) in [("/api/executor-slots".to_owned(), json!({"expectedVersion":1,"slots":6})),
        (format!("/api/projects/{project}/executor-slots"), json!({"expectedVersion":0,"slots":2}))] {
        let (status, refused) = put_route(&ws, &path, body.clone()).await;
        assert!(status == axum::http::StatusCode::BAD_REQUEST && refused["error"] == removed,
            "{path} {body}: the Workspace's and a Project's numbers are no longer saved; got {status}: {refused}");
    }
    let stored = || -> Value { serde_json::from_str(&ws.store.db.read().unwrap()
        .query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get::<_, String>(0)).unwrap()).unwrap() };
    assert_eq!(stored()["slots"], 5, "nothing changed");
    let (status, saved) = put_route(&ws, "/api/executor-slots", json!({"expectedVersion":1,"startLimitSeconds":45})).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{saved}");
    assert_eq!((stored()["slots"].clone(), stored()["startLimitSeconds"].clone()), (json!(5), json!(45)),
        "the start time limit saves, and the number older Cores read stays");
    assert_eq!(start_limit(&ws.store.db.read().unwrap()).unwrap(), Duration::from_secs(45));
    for (body, says) in [(json!({"expectedVersion":1,"startLimitSeconds":60}), "version_conflict:"),
        (json!({"expectedVersion":2,"startLimitSeconds":29}), "invalid_input: a start's time limit"),
        (json!({"expectedVersion":2}), "invalid_input: a start's time limit")] {
        let (status, refused) = put_route(&ws, "/api/executor-slots", body.clone()).await;
        assert!(status == axum::http::StatusCode::BAD_REQUEST && refused["error"].as_str().unwrap_or_default().starts_with(says),
            "{body} should be refused with {says}; got {status}: {refused}");
    }
    let view = ws.store.executor_slots_view(Some(&project)).unwrap();
    assert_eq!((view["workspace"].clone(), view["limits"].clone()), (json!({"version":2,"startLimitSeconds":45}),
        json!({"min":1,"max":MAX_SLOTS,"default":3,"startLimitSeconds":{"min":30,"max":3600,"default":300}})), "{view}");
    assert_eq!((view["machines"].clone(), view["total"].clone()),
        (json!([{"id":"local","name":"this Core host","version":0,"slots":3,"saved":false,"default":3,"executors":0}]), json!(3)),
        "each machine's limit, this Core host's first, and their sum; a Project has none: {view}");
    assert!(view.get("project").is_none());
    queued(&ws.store, "a", None, "local");
    queued(&ws.store, "b", None, "local");
    assert_eq!(started(&ws.store), ["a", "b"]);
    ws.store.executor_slot_started("a").unwrap();
    assert_eq!(ws.store.executor_slots_view(None).unwrap()["inUse"], json!({"waiting":0,"starting":1,"running":1}));
}

/// The routes take whole numbers only; null leaves a Project's unset.
#[test]
fn a_saved_limit_is_a_whole_number_or_null() {
    let save = |slots: Option<Value>| slots_of(&Save { expected_version: 0, slots, start_limit_seconds: None }).map_err(|e| e.to_string());
    assert_eq!(save(Some(json!(4))), Ok(Some(4)));
    assert_eq!(save(Some(json!(64))), Ok(Some(64)));
    assert_eq!(save(Some(Value::Null)), Ok(None));
    assert_eq!(save(None), Ok(None));
    for bad in [json!(0), json!(65), json!(2.5), json!("2"), json!(-1), json!(true)] {
        assert_eq!(save(Some(bad.clone())), Err("invalid_input: executors at once is a whole number from 1 to 64".into()), "{bad}");
    }
    let limit = |seconds: Option<Value>| start_limit_of(&Save { expected_version: 0, slots: None, start_limit_seconds: seconds })
        .map_err(|e| e.to_string());
    assert_eq!(limit(Some(json!(30))), Ok(Some(30)));
    assert_eq!(limit(Some(json!(3600))), Ok(Some(3600)));
    assert_eq!(limit(None), Ok(None));
    for bad in [json!(29), json!(3601), json!(30.5), json!("60")] {
        assert_eq!(limit(Some(bad.clone())), Err("invalid_input: a start's time limit is a whole number of seconds from 30 to 3600".into()), "{bad}");
    }
}

/// T-35 S3b (Lead 2 mail 5898): a machine's own limit, this Core host's
/// included, through its route: saved against its version, 1 to 64, null
/// clearing it for the default (YN-2 S5), for a registered machine only; the
/// Workspace keeps the start time limit. Lowering it under the executors running there stops none: no
/// more start there until fewer hold a slot.
#[tokio::test]
async fn a_machines_own_limit_is_saved_through_its_route() {
    use tower::ServiceExt;
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), dir.path().to_string_lossy().into(), "unused".into()).unwrap();
    ws.store.add_machine(&crate::remote::RemoteMachine {
        id: "lab-box".into(), name: "Lab box".into(), target: "tester@192.0.2.10".into(), ..Default::default()
    }).unwrap();
    let call = |path: &str, body: Value| {
        let request = axum::http::Request::builder().method("PUT").uri(path).header("content-type", "application/json")
            .body(axum::body::Body::from(body.to_string())).unwrap();
        let ws = ws.clone();
        async move {
            let response = router().with_state(ws).oneshot(request).await.unwrap();
            let status = response.status();
            let body = axum::body::to_bytes(response.into_body(), 1 << 20).await.unwrap();
            (status, serde_json::from_slice::<Value>(&body).unwrap_or(Value::Null))
        }
    };
    let machines = |view: &Value| view["machines"].clone();
    let row = |id: &str, name: &str, version: i64, slots: i64, saved: bool| json!({"id":id,"name":name,"version":version,
        "slots":slots,"saved":saved,"default":3,"executors":0});
    assert_eq!(machines(&ws.store.executor_slots_view(None).unwrap()),
        json!([row("local", "this Core host", 0, 3, false), row("lab-box", "Lab box", 0, 3, false)]), "none saved: the default");
    let (status, saved) = call("/api/machines/lab-box/executor-slots", json!({"expectedVersion":0,"slots":1})).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{saved}");
    assert_eq!(saved["machines"][1], row("lab-box", "Lab box", 1, 1, true));
    let (status, local) = call("/api/machines/local/executor-slots", json!({"expectedVersion":0,"slots":2})).await;
    assert_eq!((status.as_u16(), local["machines"][0]["slots"].clone()), (200, json!(2)), "this Core host's too: {local}");
    for (path, body, says) in [
        ("/api/machines/lab-box/executor-slots", json!({"expectedVersion":0,"slots":2}), "version_conflict:"),
        ("/api/machines/lab-box/executor-slots", json!({"expectedVersion":1,"slots":65}), "invalid_input: executors at once"),
        ("/api/machines/laptop/executor-slots", json!({"expectedVersion":0,"slots":1}), "machine_not_found: no registered machine is laptop"),
        ("/api/machines/lab-box/executor-slots", json!({"expectedVersion":1,"slots":1,"startLimitSeconds":60}), "invalid_input: a start's time limit is the Workspace's"),
    ] {
        let (status, refused) = call(path, body.clone()).await;
        assert!(status == axum::http::StatusCode::BAD_REQUEST && refused["error"].as_str().unwrap_or_default().starts_with(says),
            "{path} {body} should be refused with {says}; got {status}: {refused}");
    }
    // Raised to 2 and both start; lowered to 1 under them: none stops, and
    // none more starts there.
    for id in ["a", "b"] {
        queued(&ws.store, id, None, "lab-box");
    }
    assert_eq!(started(&ws.store), ["a"], "its limit of 1 holds");
    let (status, _) = call("/api/machines/lab-box/executor-slots", json!({"expectedVersion":1,"slots":2})).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    assert_eq!(started(&ws.store), ["b"]);
    let (status, lowered) = call("/api/machines/lab-box/executor-slots", json!({"expectedVersion":2,"slots":1})).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{lowered}");
    assert_eq!((state(&ws.store, "a").0, state(&ws.store, "b").0), ("starting".into(), "starting".into()), "a lower limit stops none");
    queued(&ws.store, "c", None, "lab-box");
    assert!(started(&ws.store).is_empty(), "and none more starts there");
    let (_, cleared) = call("/api/machines/lab-box/executor-slots", json!({"expectedVersion":3,"slots":null})).await;
    assert_eq!((cleared["machines"][1]["slots"].clone(), cleared["machines"][1]["saved"].clone()), (json!(3), json!(false)),
        "null clears it, for the default");
    assert_eq!(started(&ws.store), ["c"], "cleared: the default, 3, applies");
}
