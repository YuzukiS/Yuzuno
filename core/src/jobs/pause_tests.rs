//! Pause and resume as Core records them (T-107). The host side, freezing a
//! real worker cgroup, is acceptance/job-pause/host_pause_check.py.
use super::*;
use crate::{model::AgentDetail, store::Store};

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
    store
        .collaboration_call(None, "task_create", json!({"requestId":"task","title":"Training","status":"doing"}))
        .unwrap();
    (dir, store)
}
fn submit(s: &Store, id: &str) -> Value {
    let input: Submit = serde_json::from_value(json!({"requestId":id,"taskId":"T-1","name":"Small job","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0},"timeoutSeconds":3600})).unwrap();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}});
    s.create_job(Some("a"), input, json!({"cwd":"/workspace"}), machine, json!({"bootId":"boot"}))
        .unwrap()
}
/// A job the host reports running, plus a second one waiting for its capacity.
fn running(s: &Store) -> (Value, Value) {
    let job = submit(s, "first");
    let waiting = submit(s, "second");
    s.reserve_next_job(None, None, None).unwrap().unwrap();
    let id = job["id"].as_str().unwrap();
    s.update_job_evidence(id, json!({"jobId":job["id"],"attempt":job["attempt"],"status":"running","reason":"Running with verified cgroup limits","started":{"at":1792000000.0}}))
        .unwrap();
    (s.job(id).unwrap(), waiting)
}
fn answer(state: &str) -> Value {
    json!({"state":state,"reason":format!("host says {state}"),"evidence":{"freezer":{"populated":true,"frozen":state == "paused"}}})
}
fn mail(s: &Store) -> Vec<Value> {
    s.collaboration_call(Some("a"), "peer_read", json!({})).unwrap()["messages"]
        .as_array()
        .unwrap()
        .clone()
}

#[test]
fn a_paused_job_stays_running_and_keeps_every_reservation() {
    let (_dir, s) = setup();
    let (job, waiting) = running(&s);
    let id = job["id"].as_str().unwrap();
    let (requested, act) = s.request_job_pause(id, false).unwrap();
    assert!(act);
    assert_eq!(requested["pause"]["state"], "requested");
    assert_eq!(requested["pause"]["intent"], "pause");
    let paused = s.record_job_pause(id, &job["attempt"], false, &answer("paused")).unwrap();
    assert_eq!(paused["pause"]["state"], "paused");
    assert!(paused["pause"]["confirmedAt"].is_string());
    assert_eq!(paused["pause"]["evidence"]["freezer"]["frozen"], true);
    // Lifecycle and reservation are untouched: runs, retries and admission see a running job.
    assert_eq!((paused["status"].clone(), paused["reserved"].clone()), (json!("running"), json!(true)));
    assert_eq!(paused["reservation"], job["reservation"]);
    assert!(s.reserve_next_job(None, None, None).unwrap().is_none(), "the paused job's capacity is not handed to the next job");
    assert_eq!(s.job(waiting["id"].as_str().unwrap()).unwrap()["status"], "queued");
    // The Agent is told once, and told not to resubmit or read silence as failure.
    let notices = mail(&s);
    assert_eq!(notices.len(), 1);
    assert_eq!(notices[0]["metadata"]["status"], "paused");
    let body = notices[0]["body"].as_str().unwrap();
    assert!(body.contains("was paused by the user") && body.contains("Do not resubmit"), "{body}");
    assert!(body.contains("timeout still counts"), "{body}");
    // Pausing a paused job asks nothing of the host and sends nothing.
    let (again, act) = s.request_job_pause(id, false).unwrap();
    assert!(!act);
    assert_eq!(again["pause"], paused["pause"]);
    assert_eq!(mail(&s).len(), 1);
    // Lists show the pause and the timeout that still counts.
    let listed = &s.list_jobs(None, None, None).unwrap()["jobs"];
    let row = listed.as_array().unwrap().iter().find(|j| j["id"] == job["id"]).unwrap();
    assert_eq!(row["pause"]["state"], "paused");
    assert_eq!(row["timeoutSeconds"], 3600);
}

#[test]
fn resume_clears_the_pause_keeps_history_and_repeating_it_is_a_no_op() {
    let (_dir, s) = setup();
    let (job, _) = running(&s);
    let id = job["id"].as_str().unwrap();
    s.request_job_pause(id, false).unwrap();
    s.record_job_pause(id, &job["attempt"], false, &answer("paused")).unwrap();
    let (resuming, act) = s.request_job_pause(id, true).unwrap();
    assert!(act);
    assert_eq!(resuming["pause"]["state"], "resuming");
    let resumed = s.record_job_pause(id, &job["attempt"], true, &answer("running")).unwrap();
    assert!(resumed.get("pause").is_none(), "{resumed}");
    assert_eq!(resumed["pauses"].as_array().unwrap().len(), 1);
    assert!(resumed["pauses"][0]["resumedAt"].is_string());
    assert_eq!(resumed["status"], "running");
    assert_eq!(mail(&s).iter().map(|m| m["metadata"]["status"].clone()).collect::<Vec<_>>(), [json!("paused"), json!("resumed")]);
    let (_, act) = s.request_job_pause(id, true).unwrap();
    assert!(!act, "resuming a running job asks nothing of the host");
}

#[test]
fn after_a_restart_the_pause_is_still_there_and_core_never_thaws_or_resumes() {
    let (dir, s) = setup();
    let (job, _) = running(&s);
    let id = job["id"].as_str().unwrap().to_owned();
    s.request_job_pause(&id, false).unwrap();
    s.record_job_pause(&id, &job["attempt"], false, &answer("paused")).unwrap();
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let frozen = json!({"populated":true,"frozen":true});
    assert!(!s.reconcile_job_pause(&id, &job["attempt"], &frozen).unwrap(), "still frozen: nothing changes");
    assert_eq!(s.job(&id).unwrap()["pause"]["state"], "paused");
    // Thawed by someone else: say so, keep the user's intent, change nothing on the host.
    assert!(s.reconcile_job_pause(&id, &job["attempt"], &json!({"populated":true,"frozen":false})).unwrap());
    let now = s.job(&id).unwrap();
    assert_eq!(now["pause"]["state"], "unknown");
    assert_eq!(now["pause"]["intent"], "pause");
    assert!(now["pause"]["reason"].as_str().unwrap().contains("thawed outside Yuzuno"));
    assert_eq!(now["status"], "running");
    // No freezer report (the group is gone or the invocation is not this one): nothing to say.
    assert!(!s.reconcile_job_pause(&id, &job["attempt"], &Value::Null).unwrap());
}

#[test]
fn a_pending_pause_is_confirmed_only_by_the_frozen_cgroup() {
    let (_dir, s) = setup();
    let (job, _) = running(&s);
    let id = job["id"].as_str().unwrap();
    s.request_job_pause(id, false).unwrap();
    let pending = s.record_job_pause(id, &job["attempt"], false, &answer("pausing")).unwrap();
    assert_eq!(pending["pause"]["state"], "requested");
    assert!(pending["pause"]["confirmedAt"].is_null());
    assert!(mail(&s).is_empty(), "nothing is paused yet");
    assert!(!s.reconcile_job_pause(id, &job["attempt"], &json!({"populated":true,"frozen":false})).unwrap());
    assert!(s.reconcile_job_pause(id, &job["attempt"], &json!({"populated":true,"frozen":true})).unwrap());
    assert_eq!(s.job(id).unwrap()["pause"]["state"], "paused");
    assert!(!s.reconcile_job_pause(id, &job["attempt"], &json!({"populated":true,"frozen":true})).unwrap());
    assert_eq!(mail(&s).len(), 1);
}

#[test]
fn a_job_frozen_outside_yuzuno_is_shown_paused_and_a_resume_confirmed_by_the_cgroup() {
    let (_dir, s) = setup();
    let (job, _) = running(&s);
    let id = job["id"].as_str().unwrap();
    assert!(s.reconcile_job_pause(id, &job["attempt"], &json!({"populated":true,"frozen":true})).unwrap());
    let seen = s.job(id).unwrap();
    assert_eq!(seen["pause"]["state"], "paused");
    assert!(seen["pause"]["reason"].as_str().unwrap().contains("outside Yuzuno"));
    s.request_job_pause(id, true).unwrap();
    s.record_job_pause(id, &job["attempt"], true, &answer("resuming")).unwrap();
    assert_eq!(s.job(id).unwrap()["pause"]["state"], "resuming");
    assert!(s.reconcile_job_pause(id, &job["attempt"], &json!({"populated":true,"frozen":false})).unwrap());
    assert!(s.job(id).unwrap().get("pause").is_none());
}

#[test]
fn only_a_running_job_of_this_attempt_is_paused_and_failures_stay_visible() {
    let (_dir, s) = setup();
    let (job, waiting) = running(&s);
    let id = job["id"].as_str().unwrap();
    let error = s.request_job_pause(waiting["id"].as_str().unwrap(), false).unwrap_err();
    assert!(error.to_string().contains("Only a running job can be paused; this one is queued"), "{error}");
    s.request_job_pause(id, false).unwrap();
    let other = json!("another-attempt");
    assert!(s.record_job_pause(id, &other, false, &answer("paused")).is_err());
    let failed = s.record_job_pause(id, &job["attempt"], false, &answer("notPaused")).unwrap();
    assert_eq!(failed["pause"]["state"], "failed");
    assert_eq!(failed["pause"]["reason"], "host says notPaused");
    assert_eq!(failed["status"], "running");
    let unknown = s.record_job_pause(id, &job["attempt"], false, &json!({"reason":"no answer"})).unwrap();
    assert_eq!(unknown["pause"]["state"], "unknown");
    // Cancelling is not running: a job being stopped is not paused or resumed.
    s.request_job_cancel(None, id).unwrap();
    for resume in [false, true] {
        let error = s.request_job_pause(id, resume).unwrap_err();
        assert!(error.to_string().contains("this one is cancelling"), "{error}");
    }
}

#[test]
fn a_paused_job_that_reaches_its_timeout_ends_and_releases_its_reservation() {
    let (_dir, s) = setup();
    let (job, waiting) = running(&s);
    let id = job["id"].as_str().unwrap();
    s.request_job_pause(id, false).unwrap();
    s.record_job_pause(id, &job["attempt"], false, &answer("paused")).unwrap();
    s.update_job_evidence(id, json!({"jobId":job["id"],"attempt":job["attempt"],"status":"failed","reason":"timeout","finishedAtUnix":1792003600.0,"evidence":{"systemd":{"Result":"timeout"}}}))
        .unwrap();
    let ended = s.job(id).unwrap();
    assert_eq!((ended["status"].clone(), ended["reserved"].clone()), (json!("failed"), json!(false)));
    // A finished job is not paused again, and its last pause stays for the record.
    assert!(s.request_job_pause(id, false).is_err());
    assert!(!s.reconcile_job_pause(id, &job["attempt"], &json!({"populated":true,"frozen":true})).unwrap());
    assert_eq!(ended["pause"]["state"], "paused");
    assert!(s.reserve_next_job(None, None, None).unwrap().is_some());
    assert_eq!(s.job(waiting["id"].as_str().unwrap()).unwrap()["status"], "starting");
}

#[test]
fn a_device_pause_undoes_only_what_it_did() {
    use super::pause::{acts_on, closes, reopens};
    let open = json!({"admission":"open","closedBy":null,"closedReason":null});
    let ours = json!({"admission":"closed","closedBy":"user","closedReason":"Paused by the user"});
    let users_game = json!({"admission":"closed","closedBy":"user","closedReason":"A game is running"});
    let agents = json!({"admission":"closed","closedBy":"agent","closedReason":"Paused by the user"});
    assert!(closes(&open));
    assert!(!closes(&users_game) && !closes(&ours), "an existing close keeps its reason and owner");
    assert!(reopens(&ours));
    assert!(!reopens(&users_game), "a close the user made for another reason stays");
    assert!(!reopens(&agents), "an Agent's close is not the pause's");
    assert!(!reopens(&open));
    let running = json!({"status":"running"});
    let paused = json!({"status":"running","pause":{"intent":"pause","state":"paused"}});
    let pending = json!({"status":"running","pause":{"intent":"pause","state":"requested"}});
    let cancelling = json!({"status":"cancelling","pause":{"intent":"pause","state":"paused"}});
    assert!(acts_on(&running, false) && acts_on(&pending, false));
    assert!(!acts_on(&paused, false), "a paused job is not paused again");
    assert!(acts_on(&paused, true) && acts_on(&pending, true));
    assert!(!acts_on(&running, true), "a job nobody paused is not resumed");
    assert!(!acts_on(&cancelling, false) && !acts_on(&cancelling, true), "a stopping job is left alone");
}

#[tokio::test]
async fn a_device_pause_goes_on_past_a_job_that_fails_and_reports_each() {
    let tried = std::sync::Mutex::new(Vec::new());
    let out = super::pause::each_job(vec!["ended".into(), "running".into()], |id| {
        tried.lock().unwrap().push(id.clone());
        async move {
            if id == "ended" {
                anyhow::bail!("Only a running job can be paused; this one is succeeded");
            }
            Ok(json!({"id":id,"name":"Train","status":"running","pause":{"state":"paused"}}))
        }
    })
    .await;
    assert_eq!(*tried.lock().unwrap(), ["ended", "running"], "the job after the failure is still paused");
    assert_eq!(out[0], json!({"id":"ended","error":"Only a running job can be paused; this one is succeeded"}));
    assert_eq!(out[1]["pause"]["state"], "paused");
}

#[test]
fn a_resume_left_pending_by_a_restart_stays_frozen_until_the_user_asks_again() {
    // Core stopped after saving the resume request and before the host's
    // answer: the job is still frozen and marked resuming.
    let (dir, s) = setup();
    let (job, _) = running(&s);
    let id = job["id"].as_str().unwrap().to_owned();
    s.request_job_pause(&id, false).unwrap();
    s.record_job_pause(&id, &job["attempt"], false, &answer("paused")).unwrap();
    let (pending, act) = s.request_job_pause(&id, true).unwrap();
    assert!(act);
    assert_eq!(pending["pause"]["state"], "resuming");
    drop(s);
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    // Still frozen after the restart: nothing changes and nothing is resumed by Core.
    assert!(!s.reconcile_job_pause(&id, &job["attempt"], &json!({"populated":true,"frozen":true})).unwrap());
    assert_eq!(s.job(&id).unwrap()["pause"]["state"], "resuming");
    // The user asks again: the host is asked again, and its answer clears the pause.
    let (_, act) = s.request_job_pause(&id, true).unwrap();
    assert!(act, "a resume that has not taken hold can be asked again");
    let resumed = s.record_job_pause(&id, &job["attempt"], true, &answer("running")).unwrap();
    assert!(resumed.get("pause").is_none(), "{resumed}");
    assert_eq!(resumed["status"], "running");
}
