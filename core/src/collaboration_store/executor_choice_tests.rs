use super::*;
use crate::{remote::MachineBudget, store::Store};
use std::collections::BTreeMap;

/// A Workspace store with its machines as each test registers them, and a
/// Project with a folder on the machines it names.
struct Lab {
    _dir: tempfile::TempDir,
    store: Store,
}

impl Lab {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.db")).unwrap();
        // Jobs' rows below stand in for jobs of no task.
        store.db.write().unwrap().execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        Lab { _dir: dir, store }
    }

    /// An SSH machine with its Jobs budget (CPU millis, MiB), or none.
    fn machine(&self, id: &str, budget: Option<(u32, u32)>) {
        self.machine_contained(id, budget, false);
    }

    fn machine_contained(&self, id: &str, budget: Option<(u32, u32)>, contained: bool) {
        self.store.add_machine(&RemoteMachine {
            id: id.into(), name: id.into(), target: "tester@192.0.2.10".into(), contained,
            budget: budget.map(|(cpu_millis, memory_mib)| MachineBudget { cpu_millis, memory_mib }), ..Default::default()
        }).unwrap();
    }

    /// This Core host's saved Jobs budget.
    fn local_budget(&self, cpu: u64, memory: u64) {
        self.store.db.write().unwrap().execute("INSERT OR REPLACE INTO local_job_settings(id,data) VALUES(1,?1)",
            [json!({"cpuMillis":cpu,"memoryMiB":memory,"swapMiB":0}).to_string()]).unwrap();
    }

    /// A Job holding a slot on `machine` with this reservation.
    fn reserve(&self, machine: &str, cpu: u64, memory: u64) {
        let id = uuid::Uuid::new_v4().to_string();
        let executor = if machine == "local" { Value::Null } else { json!({"kind":"ssh","machineId":machine}) };
        self.store.db.write().unwrap().execute(
            "INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES(?1,'T-1','agent-a','running',1,?2)",
            [&id, &json!({"executor":executor,"reservation":{"cpuMillis":cpu,"memoryMiB":memory,"swapMiB":0}}).to_string()]).unwrap();
    }

    /// `n` executors running on `machine`.
    fn running(&self, machine: &str, n: usize) {
        for _ in 0..n {
            let agent = uuid::Uuid::new_v4().to_string();
            self.store.db.write().unwrap().execute(
                "INSERT INTO executor_slots(agent_id,seq,task_id,machine_id,template_id,state,since,queued_at)
                 VALUES(?1,(SELECT COALESCE(MAX(seq),0)+1 FROM executor_slots),'task-x',?2,'t','running','now','now')",
                [&agent, machine]).unwrap();
        }
    }

    /// `machine`'s own limit on executors at once.
    fn limit(&self, machine: &str, slots: i64) {
        self.store.db.write().unwrap().execute("INSERT OR REPLACE INTO workspace_meta(key,value) VALUES(?1,?2)",
            [crate::executor_slots::machine_key(machine), json!({"version":1,"slots":slots}).to_string()]).unwrap();
    }

    /// A Project with a folder on each of `machines`.
    fn project(&self, machines: &[&str]) -> String {
        let dirs: BTreeMap<String, String> = machines.iter().map(|m| (m.to_string(), format!("/srv/{m}/project"))).collect();
        self.store.create_project("Lab", dirs).unwrap().id
    }

    fn choose(&self, harness: &str, project: Option<&str>, worktree: Option<&str>) -> Result<(String, Value)> {
        let template: Template = serde_json::from_value(json!({"id":"t","label":"T","harness":harness})).unwrap();
        choose(&self.store.db.read().unwrap(), &template, project, worktree, None)
    }
}

/// Lead 2 Q2's acceptance: of two machines, the one with a free executor
/// slot, though the other has more spare memory.
#[test]
fn a_free_executor_slot_comes_first() {
    let lab = Lab::new();
    lab.machine("roomy", Some((4000, 16384)));
    lab.machine("small", Some((4000, 2048)));
    lab.limit("roomy", 1);
    lab.limit("small", 1);
    lab.running("roomy", 1);
    let project = lab.project(&["roomy", "small"]);
    let (chosen, choice) = lab.choose("claude", Some(&project), None).unwrap();
    assert_eq!(chosen, "small", "a free executor slot first: {choice}");
    assert_eq!(choice["candidates"][1]["freeSlot"], false, "{choice}");
}

/// Both with a free slot: the more spare memory, budget less what Jobs
/// reserve now, wins.
#[test]
fn with_free_slots_the_most_spare_memory_wins() {
    let lab = Lab::new();
    lab.machine("big-busy", Some((4000, 8192)));
    lab.machine("free", Some((4000, 4096)));
    lab.reserve("big-busy", 500, 6144);
    let project = lab.project(&["big-busy", "free"]);
    let (chosen, choice) = lab.choose("claude", Some(&project), None).unwrap();
    assert_eq!(chosen, "free", "the more spare memory: {choice}");
    assert_eq!(choice["candidates"][1]["spare"]["memoryMiB"], 2048, "{choice}");
}

/// The same spare memory: the more spare CPU.
#[test]
fn then_the_most_spare_cpu() {
    let lab = Lab::new();
    lab.machine("a-busy", Some((4000, 4096)));
    lab.machine("b-idle", Some((4000, 4096)));
    lab.reserve("a-busy", 3000, 0);
    let project = lab.project(&["a-busy", "b-idle"]);
    let (chosen, choice) = lab.choose("claude", Some(&project), None).unwrap();
    assert_eq!(chosen, "b-idle", "then the more spare CPU: {choice}");
}

/// One with no budget comes after every one with one, even one with no
/// spare memory left.
#[test]
fn a_machine_with_no_budget_ranks_after_every_one_with_one() {
    let lab = Lab::new();
    lab.machine("a-unbudgeted", None);
    lab.machine("z-full", Some((1000, 2048)));
    lab.reserve("z-full", 1000, 2048);
    let project = lab.project(&["a-unbudgeted", "z-full"]);
    let (chosen, choice) = lab.choose("claude", Some(&project), None).unwrap();
    assert_eq!(chosen, "z-full", "no budget comes last: {choice}");
    assert_eq!(choice["candidates"][1]["budget"], Value::Null, "{choice}");
}

/// The same numbers: this Core host, then the name.
#[test]
fn this_core_host_then_the_name_break_a_tie() {
    let lab = Lab::new();
    lab.local_budget(2000, 4096);
    lab.machine("lab-box", Some((2000, 4096)));
    lab.machine("alpha", Some((2000, 4096)));
    let project = lab.project(&["local", "lab-box", "alpha"]);
    let (chosen, choice) = lab.choose("claude", Some(&project), None).unwrap();
    assert_eq!(chosen, "local", "this Core host wins a tie: {choice}");
    let order: Vec<&str> = choice["candidates"].as_array().unwrap().iter().map(|c| c["machine"].as_str().unwrap()).collect();
    assert_eq!(order, ["local", "alpha", "lab-box"], "then the name");
}

/// Every machine left out is named with why, and with none left the
/// dispatch is refused, naming each.
#[test]
fn a_machine_that_cant_run_it_is_named_with_why() {
    let lab = Lab::new();
    lab.local_budget(2000, 4096);
    lab.machine_contained("boxed", Some((4000, 8192)), true);
    lab.machine("far", Some((4000, 8192)));
    lab.machine("near", Some((4000, 8192)));
    let project = lab.project(&["boxed", "near"]);
    let why = |choice: &Value, machine: &str| choice["candidates"].as_array().unwrap().iter()
        .find(|c| c["machine"] == machine).and_then(|c| c["excluded"].as_str().map(str::to_owned));

    let (chosen, choice) = lab.choose("codex", Some(&project), None).unwrap();
    assert_eq!(chosen, "near", "{choice}");
    assert!(why(&choice, "boxed").is_some_and(|w| w.contains("keeps its Agents contained")), "{choice}");
    assert!(why(&choice, "far").is_some_and(|w| w.contains("its Project has no folder there")), "{choice}");
    assert!(why(&choice, "local").is_some_and(|w| w.contains("no worktree")), "{choice}");

    let (chosen, choice) = lab.choose("claude", Some(&project), Some("/synthetic/worktree")).unwrap();
    assert_eq!(chosen, "local", "a worktree is a path on this Core host: {choice}");
    assert!(why(&choice, "near").is_some_and(|w| w.contains("carries the worktree /synthetic/worktree")), "{choice}");

    let (chosen, choice) = lab.choose("opencode", Some(&project), Some("/synthetic/worktree")).unwrap();
    assert_eq!(chosen, "local", "{choice}");
    assert!(why(&choice, "near").is_some_and(|w| w.contains("OpenCode executors run on this Core host only")), "{choice}");

    let refused = lab.choose("codex", None, None).unwrap_err().to_string();
    assert!(refused.starts_with("no_machine: no machine can run this executor"), "{refused}");
    assert!(refused.contains("boxed: it keeps its Agents contained") && refused.contains("near: this task is in no Project"), "{refused}");
}

/// The record lists every candidate in order with the numbers it was ranked
/// by, so the order can be read again from them alone.
#[test]
fn the_record_reads_the_order_again() {
    let lab = Lab::new();
    lab.local_budget(4000, 8192);
    lab.reserve("local", 1000, 7168);
    lab.machine("a", Some((4000, 8192)));
    lab.machine("b", Some((4000, 4096)));
    lab.machine("c", None);
    lab.limit("a", 1);
    lab.running("a", 1);
    let project = lab.project(&["local", "a", "b", "c"]);
    let (chosen, choice) = lab.choose("claude", Some(&project), None).unwrap();
    assert_eq!((choice["requested"].as_str(), choice["chosen"].as_str()), (Some("auto"), Some(chosen.as_str())));
    let listed = choice["candidates"].as_array().unwrap().clone();
    let key = |c: &Value| (
        c["freeSlot"] != true,
        c["budget"].is_null(),
        std::cmp::Reverse(c["spare"]["memoryMiB"].as_u64().unwrap_or(0)),
        std::cmp::Reverse(c["spare"]["cpuMillis"].as_u64().unwrap_or(0)),
        c["machine"] != "local",
        c["name"].as_str().unwrap().to_owned(),
    );
    let mut again = listed.clone();
    again.sort_by_key(key);
    assert_eq!(again, listed, "read again from the record's numbers, the same order");
    let order: Vec<&str> = listed.iter().map(|c| c["machine"].as_str().unwrap()).collect();
    assert_eq!(order, ["b", "local", "c", "a"], "{choice}");
    assert_eq!(listed[1]["reserved"], json!({"cpuMillis":1000,"memoryMiB":7168}), "{choice}");
    assert_eq!((listed[3]["executors"].as_i64(), listed[3]["limit"].as_i64()), (Some(1), Some(1)), "{choice}");
}
