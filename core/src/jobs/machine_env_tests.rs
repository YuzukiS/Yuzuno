//! Each machine's Job environment as a Job takes it (YN-194): merged under
//! the Job's own when it is created and kept on its record, never part of
//! what a retry is compared with, and removed with its machine.
use super::*;
use crate::{model::AgentDetail, store::Store};
use std::collections::BTreeMap;

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
    store
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Builds","status":"doing"}))
        .unwrap();
    (dir, store)
}
fn input(id: &str, env: Value) -> Submit {
    let mut input: Submit = serde_json::from_value(json!({"requestId":id,"taskId":"T-1","name":"Build","cwd":"/workspace",
        "argv":["cargo","test"],"env":env,"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0}})).unwrap();
    input.default_env();
    input
}
fn machine() -> Value {
    json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}})
}
fn create(s: &Store, input: Submit) -> anyhow::Result<Value> {
    s.create_job(Some("a"), input, json!({"cwd":"/workspace"}), machine(), json!({"bootId":"boot"}))
}
fn env(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

#[test]
fn a_job_on_this_host_takes_its_machines_environment_under_its_own() {
    let (_dir, s) = setup();
    s.set_machine_env("local", &env(&[("HOME", "/home/example"), ("PATH", "/home/example/.cargo/bin:/usr/bin:/bin"), ("RUST_LOG", "warn")]))
        .unwrap();
    let job = create(&s, input("one", json!({"RUST_LOG":"debug"}))).unwrap();
    assert_eq!(job["env"]["HOME"], "/home/example");
    assert_eq!(job["env"]["PATH"], "/home/example/.cargo/bin:/usr/bin:/bin", "the machine's replaces Core's default");
    assert_eq!(job["env"]["RUST_LOG"], "debug", "the Job's own wins");
    assert_eq!(job["env"]["LANG"], "C.UTF-8");
    assert_eq!(job["envFromMachine"], json!(["HOME", "PATH"]));
    // The record keeps it; its retry is the submission as sent, whatever the
    // setting says by then.
    s.set_machine_env("local", &env(&[("HOME", "/elsewhere")])).unwrap();
    let again = s.previous_job(Some("a"), &input("one", json!({"RUST_LOG":"debug"}))).unwrap().unwrap();
    assert_eq!(again["id"], job["id"]);
    assert_eq!(s.job(job["id"].as_str().unwrap()).unwrap()["env"]["HOME"], "/home/example");
    // A new Job takes the setting as it is now; none set, nothing more.
    let next = create(&s, input("two", json!({}))).unwrap();
    assert_eq!(next["env"]["HOME"], "/elsewhere");
    assert_eq!(next["env"]["PATH"], "/usr/local/bin:/usr/bin:/bin");
    s.set_machine_env("local", &BTreeMap::new()).unwrap();
    let plain = create(&s, input("three", json!({}))).unwrap();
    assert!(plain["env"].get("HOME").is_none() && plain.get("envFromMachine").is_none(), "{plain}");
    assert_eq!(s.machine_envs().unwrap()["machines"], json!({}));
}

#[test]
fn a_merged_environment_past_a_jobs_limits_queues_nothing() {
    let (_dir, s) = setup();
    let wide: BTreeMap<String, String> = (0..32).map(|n| (format!("M{n}"), "v".into())).collect();
    s.set_machine_env("local", &wide).unwrap();
    let own: serde_json::Map<String, Value> = (0..40).map(|n| (format!("J{n}"), json!("v"))).collect();
    let error = create(&s, input("big", Value::Object(own))).unwrap_err().to_string();
    assert!(error.contains("machine local") && error.contains("Settings → Machines"), "{error}");
    assert_eq!(s.list_jobs(None, None, None).unwrap()["jobs"].as_array().unwrap().len(), 0);
}

#[test]
fn a_setting_names_a_known_machine_and_goes_with_it() {
    let (_dir, s) = setup();
    let error = s.set_machine_env("m1", &env(&[("HOME", "/h")])).unwrap_err().to_string();
    assert!(error.contains("No machine \"m1\""), "{error}");
    s.set_machine_env("windows", &env(&[("CARGO_HOME", r"C:\Users\example\.cargo")])).unwrap();
    let machine: crate::remote::RemoteMachine = serde_json::from_value(json!({"id":"m1","name":"Lab","target":"lab.example",
        "codex":"codex","defaultCwd":"/srv/work"})).unwrap();
    s.add_machine(&machine).unwrap();
    s.set_machine_env("m1", &env(&[("HOME", "/home/lab")])).unwrap();
    let all = s.machine_envs().unwrap();
    assert_eq!(all["machines"]["m1"]["env"], json!({"HOME":"/home/lab"}));
    assert_eq!(all["machines"]["windows"]["env"]["CARGO_HOME"], r"C:\Users\example\.cargo");
    assert_eq!(all["defaults"]["PATH"], "/usr/local/bin:/usr/bin:/bin");
    s.remove_machine("m1").unwrap();
    assert!(s.machine_envs().unwrap()["machines"].get("m1").is_none());
    assert!(s.set_machine_env("local", &env(&[("YUZUNO_JOB_ID", "x")])).is_err());
}
