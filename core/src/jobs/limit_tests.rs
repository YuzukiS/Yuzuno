//! T-38 B: lowering a running Job's memory limit. The host's answer is given
//! here as host.py `limit` writes it (acceptance/local-jobs/limit_host_test.py
//! tests that); acceptance/t38-shrink/check.py runs the real set-property and
//! read-back on systemd user Jobs of a lab Core, and acceptance/t57-limit-retry
//! a retry of the same value after a lowering whose answer was lost.
use super::*;
use crate::{model::AgentDetail, store::Store};

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    for id in ["a", "b"] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        store.insert(&agent).unwrap();
    }
    store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Memory checks","status":"doing"})).unwrap();
    store.set_job_budget(Resources { cpu_millis: 4000, memory_mi_b: 4096, swap_mi_b: 0 }).unwrap();
    (dir, store)
}
fn job(s: &Store, name: &str, memory: u64) -> Value {
    let request: Submit = serde_json::from_value(json!({"requestId":name,"taskId":"T-1","name":name,"cwd":"/workspace",
        "argv":["/usr/bin/true"],"resources":{"cpuMillis":500,"memoryMiB":memory,"swapMiB":0}})).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":4000,"memoryMiB":4096,"swapMiB":0}});
    s.create_job(Some("a"), request, json!({"cwd":"/workspace"}), machine, json!({"bootId":"boot"})).unwrap()
}
fn running(s: &Store, name: &str, memory: u64) -> Value {
    let queued = job(s, name, memory);
    let started = s.reserve_next_job(None, None, None).unwrap().unwrap();
    assert_eq!(started["id"], queued["id"]);
    s.update_job_evidence(queued["id"].as_str().unwrap(),
        json!({"jobId":queued["id"],"attempt":started["attempt"],"status":"running","reason":"Running","evidence":{"InvocationID":"one"}})).unwrap();
    s.job(queued["id"].as_str().unwrap()).unwrap()
}
fn limited(to: u64) -> Value {
    json!({"state":"limited","reason":format!("Memory limit lowered to {to} MiB"),"evidence":{"memoryMaxAfter":to * 1048576}})
}
fn id(job: &Value) -> &str {
    job["id"].as_str().unwrap()
}

#[test]
fn a_lowered_limit_lowers_the_request_and_reservation_at_once_and_a_queued_job_starts() {
    let (_dir, s) = setup();
    // 3,968 + 64 of the 4,096 MiB: a 1,024 MiB job waits.
    let big = running(&s, "calibration", 3968);
    let next = job(&s, "next", 1024);
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none());
    s.check_job_limit(None, id(&big), 1024).unwrap();
    let after = s.record_job_limit(None, id(&big), &big["attempt"], 1024, &limited(1024)).unwrap();
    assert_eq!(after["resources"]["memoryMiB"], 1024);
    assert_eq!(after["reservation"]["memoryMiB"], 1088, "the reservation follows, with its collector");
    assert_eq!(after["resources"]["swapMiB"], 0, "swap stays as reserved");
    let change = &after["limitChanges"][0];
    assert_eq!((change["fromMiB"].clone(), change["toMiB"].clone(), change["by"]["kind"].clone()), (json!(3968), json!(1024), json!("user")));
    assert!(change["confirmedByRetry"].is_null(), "an ordinary lowering is not marked as a retry");
    // The task says so too.
    let activity: String = s.db.read().unwrap().query_row(
        "SELECT data FROM collaboration_task_activity WHERE json_extract(data,'$.jobId')=?1", [id(&big)], |r| r.get(0)).unwrap();
    assert!(activity.contains("lowered from 3968 MiB to 1024 MiB by You"), "{activity}");
    // What it freed is used at once.
    assert_eq!(s.reserve_next_job(None, None, None).unwrap().unwrap()["id"], next["id"], "the queued job starts");
}

#[test]
fn only_a_running_local_job_only_down_and_only_the_user_or_its_own_agent() {
    let (_dir, s) = setup();
    let run = running(&s, "run", 2048);
    let error = |r: anyhow::Result<Value>| r.unwrap_err().to_string();
    assert!(error(s.check_job_limit(None, id(&run), 2048)).contains("a memory limit is only lowered, never raised"));
    assert!(error(s.check_job_limit(None, id(&run), 3000)).contains("only lowered, never raised"));
    assert!(error(s.check_job_limit(Some("b"), id(&run), 1024)).contains("Only the user or the Agent that submitted the job"));
    s.check_job_limit(Some("a"), id(&run), 1024).expect("its own Agent may");
    let queued = job(&s, "queued", 4000);
    assert!(error(s.check_job_limit(None, id(&queued), 1024)).contains("Only a running job's memory limit can be lowered; this one is queued"));
    // A job on another machine: its helper has no such action.
    s.db.write().unwrap().execute("UPDATE local_jobs SET data=json_set(data,'$.executor',json('{\"kind\":\"ssh\",\"machineName\":\"owl\"}')) WHERE id=?1", [id(&run)]).unwrap();
    assert!(error(s.check_job_limit(None, id(&run), 1024)).contains("not supported on owl"));
}

#[test]
fn a_refused_lowering_keeps_the_request_and_says_why() {
    let (_dir, s) = setup();
    let run = running(&s, "run", 2048);
    let answer = json!({"state":"notLimited","reason":"700 MiB is below what the job uses now plus 256 MiB (812 MiB); nothing was changed","evidence":{}});
    let after = s.record_job_limit(None, id(&run), &run["attempt"], 700, &answer).unwrap();
    assert_eq!((after["resources"]["memoryMiB"].clone(), after["reservation"]["memoryMiB"].clone()), (json!(2048), json!(2112)));
    assert!(after["limitChanges"].is_null());
    assert_eq!(after["limitRefusal"]["reason"], answer["reason"]);
}

#[test]
fn a_job_killed_for_memory_after_a_lowering_names_the_lowered_limit() {
    let (_dir, s) = setup();
    let oom = |job: &Value| json!({"jobId":job["id"],"attempt":job["attempt"],"status":"failed","reason":"oom-kill",
        "evidence":{"systemd":{"Result":"oom-kill"}}});
    let lowered = running(&s, "lowered", 2048);
    s.record_job_limit(Some("a"), id(&lowered), &lowered["attempt"], 1024, &limited(1024)).unwrap();
    s.update_job_evidence(id(&lowered), oom(&lowered)).unwrap();
    let reason = s.job(id(&lowered)).unwrap()["reason"].as_str().unwrap().to_owned();
    assert!(reason.starts_with("Out of memory at the lowered limit of 1024 MiB: Agent a lowered it from 2048 MiB at "), "{reason}");
    // Without a lowering the reason is the host's.
    let plain = running(&s, "plain", 1024);
    s.update_job_evidence(id(&plain), oom(&plain)).unwrap();
    assert_eq!(s.job(id(&plain)).unwrap()["reason"], "oom-kill");
}

/// T-57: a lowering that took effect without its answer reaching Core left
/// the request and reservation as they were: Core never holds less than the
/// Job may use. The same value asked again is confirmed, as host.py answers
/// it (`limited`, `confirmedByRetry`): the request and reservation follow,
/// with one audit entry marked so, and what they free starts queued work.
#[test]
fn a_retry_of_the_same_value_confirms_a_lowering_whose_answer_was_lost() {
    let (_dir, s) = setup();
    let big = running(&s, "calibration", 3968);
    let next = job(&s, "next", 1024);
    let lost = json!({"state":"unknown","reason":"The host helper did not confirm the new limit: timed out after 30 s"});
    let first = s.record_job_limit(None, id(&big), &big["attempt"], 1024, &lost).unwrap();
    assert_eq!((first["resources"]["memoryMiB"].clone(), first["reservation"]["memoryMiB"].clone()), (json!(3968), json!(4032)),
        "unconfirmed, the Job holds what it held");
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none(), "nothing starts on an unconfirmed lowering");
    s.check_job_limit(None, id(&big), 1024).expect("the same value may be asked again");
    let retry = json!({"state":"limited","confirmedByRetry":true,
        "reason":"The memory limit is already 1024 MiB: an earlier lowering took effect, and this retry confirms it; nothing was changed",
        "evidence":{"memoryMaxBefore":1073741824u64,"memoryMaxAfter":1073741824u64}});
    let after = s.record_job_limit(None, id(&big), &big["attempt"], 1024, &retry).unwrap();
    assert_eq!(after["resources"]["memoryMiB"], 1024, "the retry confirms the request");
    assert_eq!(after["reservation"]["memoryMiB"], 1088, "the reservation follows, with its collector");
    let changes = after["limitChanges"].as_array().unwrap();
    assert_eq!(changes.len(), 1, "one audit entry: {changes:?}");
    assert_eq!((changes[0]["fromMiB"].clone(), changes[0]["toMiB"].clone(), changes[0]["by"]["kind"].clone()), (json!(3968), json!(1024), json!("user")));
    assert_eq!(changes[0]["confirmedByRetry"], true, "the audit says a retry confirmed it");
    assert!(after["limitRefusal"].is_null(), "the lost answer is no longer the last word");
    let activity: String = s.db.read().unwrap().query_row(
        "SELECT data FROM collaboration_task_activity WHERE json_extract(data,'$.jobId')=?1", [id(&big)], |r| r.get(0)).unwrap();
    assert!(activity.contains("lowered from 3968 MiB to 1024 MiB by You, confirmed by a retry of the same value"),
        "the task says a retry confirmed it: {activity}");
    assert_eq!(s.reserve_next_job(None, None, None).unwrap().unwrap()["id"], next["id"], "the queued job starts");
}
