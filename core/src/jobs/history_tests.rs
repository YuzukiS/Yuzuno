//! YN-142: the Job history at its limit makes room by removing the oldest
//! finished units nothing holds, in the insert's own transaction.
use super::history::{self, Keep, LIMIT, TARGET};
use super::*;
use crate::{model::AgentDetail, store::Store};
use rusqlite::{params, Connection};
use std::sync::{Arc, Barrier};

fn setup() -> (tempfile::TempDir, Arc<Store>) {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(Store::open(&dir.path().join("workspace.sqlite")).unwrap());
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&agent).unwrap();
    for (request, status) in [("open", "doing"), ("closed", "doing")] {
        store
            .collaboration_call(None, "task_create", json!({"requestId":request,"title":request,"status":status}))
            .unwrap();
    }
    (dir, store)
}
fn task(s: &Store, key: &str) -> String {
    crate::collaboration_store::task_key(&s.db.read().unwrap(), key).unwrap().0
}
fn input(id: &str) -> Submit {
    serde_json::from_value(json!({"requestId":id,"taskId":"T-1","name":"Small job","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":500,"memoryMiB":128,"swapMiB":0}})).unwrap()
}
fn submit(s: &Store, id: &str) -> Result<Value> {
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}});
    s.create_job(Some("a"), input(id), json!({"cwd":"/workspace"}), machine, json!({"bootId":"boot"}))
}
/// Second `n` of a fixed day: the order Jobs finished in.
fn at(n: i64) -> String {
    (chrono::DateTime::parse_from_rfc3339("2026-01-01T00:00:00+00:00").unwrap() + chrono::Duration::seconds(n)).to_rfc3339()
}
/// A Job record as it is stored, without anything a test does not read.
fn row(db: &Connection, task: &str, status: &str, finished: i64, extra: Value) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let mut data = json!({"id":id,"taskId":task,"agentId":"a","status":status,"reserved":false,
        "createdAt":at(finished - 1),"finishedAt":at(finished),"name":"old"});
    for (k, v) in extra.as_object().unwrap() {
        data[k] = v.clone();
    }
    let reserved = data["reserved"] == true;
    db.execute(
        "INSERT INTO local_jobs(id,task_id,agent_id,status,reserved,data) VALUES(?1,?2,'a',?3,?4,?5)",
        params![id, task, status, reserved, data.to_string()],
    )
    .unwrap();
    id
}
/// `n` finished Jobs of `task`, finishing after `from`, in one transaction.
fn fill(s: &Store, task: &str, from: i64, n: i64) -> Vec<String> {
    let mut db = s.db.write().unwrap();
    let tx = db.transaction().unwrap();
    let ids = (0..n).map(|i| row(&tx, task, "succeeded", from + i, json!({}))).collect();
    tx.commit().unwrap();
    ids
}
fn count(s: &Store, sql: &str) -> i64 {
    s.db.read().unwrap().query_row(sql, [], |r| r.get(0)).unwrap()
}
fn exists(s: &Store, id: &str) -> bool {
    count(s, &format!("SELECT COUNT(*) FROM local_jobs WHERE id='{id}'")) == 1
}
fn orphans(s: &Store) -> i64 {
    count(s, "SELECT COUNT(*) FROM local_job_run_attempts a WHERE NOT EXISTS(SELECT 1 FROM local_jobs j WHERE j.id=a.job_id)")
}
/// A run as stored: settled or not, waiting for others or not, with these
/// attempt Jobs.
fn run(db: &Connection, task: &str, settled: Option<i64>, after: &[&str], jobs: &[String]) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let mut data = json!({"id":id,"taskId":task,"agentId":"a","name":"run","stages":[{"key":"s"}],
        "createdAt":at(0),"settledAt":settled.map(at)});
    if !after.is_empty() {
        data["afterRuns"] = json!(after.iter().map(|r| json!({"runId":r,"when":"settled"})).collect::<Vec<_>>());
    }
    db.execute("INSERT INTO local_job_runs(id,task_id,agent_id,data) VALUES(?1,?2,'a',?3)", params![id, task, data.to_string()]).unwrap();
    for (n, job) in jobs.iter().enumerate() {
        db.execute("INSERT INTO local_job_run_attempts(run_id,stage,attempt,job_id) VALUES(?1,'s',?2,?3)", params![id, n as i64 + 1, job]).unwrap();
    }
    id
}

#[test]
fn a_full_history_removes_the_first_finished_down_to_the_target_and_takes_the_new_job() {
    let (_dir, s) = setup();
    let t1 = task(&s, "T-1");
    // The lowest seq finished last: oldest means finished first, not submitted first.
    let late = {
        let db = s.db.write().unwrap();
        row(&db, &t1, "succeeded", 100_000, json!({}))
    };
    let ids = fill(&s, &t1, 10, LIMIT - 1);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), LIMIT);
    let job = submit(&s, "new").unwrap();
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), TARGET + 1);
    assert!(exists(&s, job["id"].as_str().unwrap()));
    assert!(exists(&s, &late), "finished last, so kept");
    let removed = (LIMIT - TARGET) as usize;
    assert!(ids[..removed].iter().all(|id| !exists(&s, id)), "the first finished go");
    assert!(ids[removed..].iter().all(|id| exists(&s, id)), "the rest stay");
    // Their folders wait for the job loop; job_cost says what left.
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_job_pruned_folders"), removed as i64);
    let cost = s.task_cost("T-1").unwrap();
    assert_eq!((cost["prunedAttempts"].clone(), cost["prunedRuns"].clone(), cost["truncated"].clone()),
        (json!(removed), json!(0), json!(true)), "{cost}");
    assert_eq!(cost["usd"]["complete"], false);
    assert_eq!(cost["attemptsTruncated"], false, "the newest-5000 window is not what made it partial");
    // Below the limit nothing more is removed.
    submit(&s, "next").unwrap();
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), TARGET + 2);
}

#[test]
fn what_still_reads_a_job_keeps_it_and_a_closed_tasks_citations_do_not() {
    let (_dir, s) = setup();
    let (open, closed) = (task(&s, "T-1"), task(&s, "T-2"));
    let mut held = Vec::new();
    let mut gone = Vec::new();
    {
        let db = s.db.write().unwrap();
        // The first finished: each held by one thing that still reads it.
        held.push(row(&db, &open, "running", 1, json!({"reserved":true,"finishedAt":null})));
        held.push(row(&db, &open, "succeeded", 2, json!({"reserved":true})));
        held.push(row(&db, &open, "cancelled", 3, json!({"checkpointStop":{"state":"checkpointed"}})));
        gone.push(row(&db, &open, "cancelled", 4, json!({"checkpointStop":{"state":"checkpointed","resumedAs":"next"}})));
        let service = row(&db, &open, "failed", 5, json!({}));
        db.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
        db.execute("INSERT INTO project_service_jobs(service_id,job_id,linked_at) VALUES('svc',?1,'now')", [&service]).unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        held.push(service);
        let inventory = row(&db, &open, "succeeded", 6, json!({}));
        db.execute("INSERT INTO cleanup_inventories(actor,request_id,task_id,machine,folder,identity,job_id,created_at) VALUES('a','r',?1,'local','/w','i',?2,'now')", params![open, inventory]).unwrap();
        held.push(inventory);
        // Cited by a result, a research record and review evidence: kept on
        // the open task, removable on the closed one.
        for (task, list) in [(&open, &mut held), (&closed, &mut gone)] {
            let (result, research, evidence) = (row(&db, task, "succeeded", 7, json!({})), row(&db, task, "succeeded", 8, json!({})), row(&db, task, "succeeded", 9, json!({})));
            db.execute("INSERT INTO collaboration_task_activity(task_id,data) VALUES(?1,?2)", params![task,
                json!({"kind":"result","result":{"outcome":{"criteria":[{"artifacts":[{"jobId":result}]}]}}}).to_string()]).unwrap();
            db.execute("INSERT INTO collaboration_task_activity(task_id,data) VALUES(?1,?2)", params![task,
                json!({"kind":"commented","research":{"sources":[{"kind":"job","jobId":research}]}}).to_string()]).unwrap();
            db.execute("INSERT INTO pr_review_evidence(id,task_id,actor,request_id,input,data) VALUES(?1,?2,'a',?1,'{}',?3)", params![uuid::Uuid::new_v4().to_string(), task,
                json!({"reference":{"jobId":evidence}}).to_string()]).unwrap();
            list.extend([result, research, evidence]);
        }
        // A mere mention in other activity holds nothing.
        let mentioned = row(&db, &open, "succeeded", 10, json!({}));
        db.execute("INSERT INTO collaboration_task_activity(task_id,data) VALUES(?1,?2)", params![open,
            json!({"kind":"updated","note":{"jobId":mentioned}}).to_string()]).unwrap();
        gone.push(mentioned);
        db.execute("UPDATE collaboration_tasks SET data=json_set(data,'$.status','done') WHERE id=?1", [&closed]).unwrap();
    }
    let rest = fill(&s, &open, 100, LIMIT - count(&s, "SELECT COUNT(*) FROM local_jobs"));
    submit(&s, "new").unwrap();
    for id in &held {
        assert!(exists(&s, id), "held {id}");
    }
    for id in &gone {
        assert!(!exists(&s, id), "removable {id}");
    }
    // Room came from the next oldest instead.
    let removed = (LIMIT - TARGET) as usize - gone.len();
    assert!(rest[..removed].iter().all(|id| !exists(&s, id)));
    assert!(rest[removed..].iter().all(|id| exists(&s, id)));
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), TARGET + 1);
}

#[test]
fn a_run_goes_whole_once_settled_and_stays_whole_while_anything_holds_it() {
    let (_dir, s) = setup();
    let t1 = task(&s, "T-1");
    let (settled, open, awaited, waiting, cited);
    let mut jobs = std::collections::HashMap::new();
    {
        let db = s.db.write().unwrap();
        let attempts = |db: &Connection, first: i64| (0..2).map(|i| row(db, &t1, "failed", first + i, json!({}))).collect::<Vec<_>>();
        let a = attempts(&db, 1);
        settled = run(&db, &t1, Some(3), &[], &a);
        jobs.insert("settled", a);
        let b = attempts(&db, 4);
        open = run(&db, &t1, None, &[], &b);
        jobs.insert("open", b);
        let c = attempts(&db, 6);
        awaited = run(&db, &t1, Some(8), &[], &c);
        jobs.insert("awaited", c);
        waiting = run(&db, &t1, None, &[&awaited], &[]);
        let d = attempts(&db, 9);
        db.execute("INSERT INTO collaboration_task_activity(task_id,data) VALUES(?1,?2)", params![t1,
            json!({"kind":"result","result":{"outcome":{"criteria":[{"artifacts":[{"jobId":d[1]}]}]}}}).to_string()]).unwrap();
        cited = run(&db, &t1, Some(11), &[], &d);
        jobs.insert("cited", d);
    }
    let rest = fill(&s, &t1, 100, LIMIT - count(&s, "SELECT COUNT(*) FROM local_jobs"));
    submit(&s, "new").unwrap();
    let runs = |id: &str| count(&s, &format!("SELECT COUNT(*) FROM local_job_runs WHERE id='{id}'"));
    let attempts = |id: &str| count(&s, &format!("SELECT COUNT(*) FROM local_job_run_attempts WHERE run_id='{id}'"));
    assert_eq!((runs(&settled), attempts(&settled)), (0, 0), "a settled run nothing holds goes whole");
    assert!(jobs["settled"].iter().all(|id| !exists(&s, id)));
    for (name, id) in [("open", &open), ("awaited", &awaited), ("cited", &cited)] {
        assert_eq!((runs(id), attempts(id)), (1, 2), "{name} stays whole");
        assert!(jobs[name].iter().all(|j| exists(&s, j)), "{name}");
    }
    assert_eq!(runs(&waiting), 1);
    assert_eq!(orphans(&s), 0);
    assert_eq!(count(&s, "SELECT jobs FROM local_job_history_pruned"), (LIMIT - TARGET));
    assert_eq!(count(&s, "SELECT runs FROM local_job_history_pruned"), 1);
    assert!(rest[..(LIMIT - TARGET) as usize - 2].iter().all(|id| !exists(&s, id)));
}

#[test]
fn a_history_nothing_can_leave_refuses_the_job_and_removes_nothing() {
    let (_dir, s) = setup();
    let t1 = task(&s, "T-1");
    {
        let mut db = s.db.write().unwrap();
        let tx = db.transaction().unwrap();
        for i in 0..150 {
            row(&tx, &t1, "running", i, json!({"reserved":true,"finishedAt":null}));
        }
        for i in 150..LIMIT {
            let id = row(&tx, &t1, "succeeded", i, json!({}));
            tx.execute("INSERT INTO collaboration_task_activity(task_id,data) VALUES(?1,?2)", params![t1,
                json!({"kind":"result","result":{"outcome":{"criteria":[{"artifacts":[{"jobId":id}]}]}}}).to_string()]).unwrap();
        }
        tx.commit().unwrap();
    }
    let error = submit(&s, "new").unwrap_err().to_string();
    assert!(error.starts_with("Local job history is full (5000) and too few finished Jobs can be removed"), "{error}");
    assert!(error.contains("150 unfinished or holding resources") && error.contains("4850 cited by an open task"), "{error}");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), LIMIT);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_job_history_pruned"), 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_job_pruned_folders"), 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM collaboration_requests WHERE request_id='new'"), 0);
}

#[test]
fn a_submission_refused_after_the_removal_undoes_it() {
    let (_dir, s) = setup();
    let t1 = task(&s, "T-1");
    {
        let db = s.db.write().unwrap();
        // The queue is full: the submission is refused after room was made.
        for i in 0..200 {
            row(&db, &t1, "queued", i, json!({"finishedAt":null}));
        }
    }
    fill(&s, &t1, 1000, LIMIT - 200);
    let error = submit(&s, "new").unwrap_err().to_string();
    assert!(error.contains("Local job queue is full (200)"), "{error}");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), LIMIT);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_job_history_pruned"), 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_job_pruned_folders"), 0);
}

#[test]
fn a_removal_that_does_not_check_out_is_undone_even_when_its_caller_commits() {
    let (_dir, s) = setup();
    let t1 = task(&s, "T-1");
    fill(&s, &t1, 0, LIMIT);
    let mut db = s.db.write().unwrap();
    // A stand-in fault: each removal brings back an unfinished Job.
    db.execute_batch(&format!(
        "CREATE TEMP TRIGGER fault AFTER DELETE ON local_jobs BEGIN
           INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(old.id||'-x','{t1}','a','running','{{}}');
         END;"
    ))
    .unwrap();
    let tx = db.transaction().unwrap();
    let error = history::make_room(&tx, 1, &Keep::default()).unwrap_err().to_string();
    assert!(error.starts_with("Job history removal did not check out"), "{error}");
    tx.commit().unwrap();
    db.execute_batch("DROP TRIGGER temp.fault").unwrap();
    drop(db);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), LIMIT);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs WHERE status='running'"), 0);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_job_history_pruned"), 0);
}

#[test]
fn submissions_at_the_limit_at_once_all_get_room_and_leave_no_half_removal() {
    let (_dir, s) = setup();
    let t1 = task(&s, "T-1");
    fill(&s, &t1, 0, LIMIT);
    let threads = 8;
    let barrier = Arc::new(Barrier::new(threads));
    let handles: Vec<_> = (0..threads)
        .map(|n| {
            let (s, barrier) = (s.clone(), barrier.clone());
            std::thread::spawn(move || {
                barrier.wait();
                submit(&s, &format!("at-once-{n}")).map(|job| job["id"].as_str().unwrap().to_owned())
            })
        })
        .collect();
    let ids: Vec<String> = handles.into_iter().map(|h| h.join().unwrap().unwrap()).collect();
    assert!(ids.iter().all(|id| exists(&s, id)));
    // One removal made room for all of them.
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), TARGET + threads as i64);
    assert_eq!(count(&s, "SELECT jobs FROM local_job_history_pruned"), LIMIT - TARGET);
    assert_eq!(orphans(&s), 0);
}

/// A finished Job with one verified artifact, as a result cites it.
fn with_artifact(s: &Store, finished: i64) -> (String, String) {
    let attempt = uuid::Uuid::new_v4().to_string();
    let sha = "a".repeat(64);
    let db = s.db.write().unwrap();
    let id = row(&db, &task(s, "T-1"), "succeeded", finished, json!({"attempt":attempt,
        "result":{"attempt":attempt,"artifacts":[{"path":"out.txt","sha256":sha,"ok":true,"bytes":1}]}}));
    (id, attempt)
}
fn cite(s: &Store, request: &str, job: &str, attempt: &str) -> Result<Value> {
    let version = s.collaboration_call(None, "task_get", json!({"taskId":"T-1","view":"current"})).unwrap()["current"]["version"].clone();
    s.collaboration_call(None, "task_submit_result", json!({"requestId":request,"taskId":"T-1","expectedVersion":version,
        "status":"doing","summary":"evidence","outcome":{"criteria":[{"id":"c","label":"c","report":"r","reportedStatus":"met",
        "artifacts":[{"jobId":job,"attempt":attempt,"path":"out.txt","sha256":"a".repeat(64)}]}]}}))
}

#[test]
fn a_result_cited_before_the_removal_keeps_its_job_and_one_after_it_is_refused() {
    let (_dir, s) = setup();
    let (first, first_attempt) = with_artifact(&s, 1);
    let (second, second_attempt) = with_artifact(&s, 2);
    cite(&s, "before", &first, &first_attempt).unwrap();
    fill(&s, &task(&s, "T-1"), 100, LIMIT - 2);
    submit(&s, "new").unwrap();
    assert!(exists(&s, &first), "cited by an open task before the removal");
    assert!(!exists(&s, &second), "nothing cited it yet");
    let error = cite(&s, "after", &second, &second_attempt).unwrap_err().to_string();
    assert!(error.contains("(job_missing)"), "{error}");
}

#[test]
fn a_replayed_request_whose_job_was_removed_is_refused_not_made_again() {
    let (_dir, s) = setup();
    let old = submit(&s, "old").unwrap();
    {
        let db = s.db.write().unwrap();
        db.execute("UPDATE local_jobs SET status='succeeded', data=json_set(data,'$.status','succeeded','$.finishedAt',?2) WHERE id=?1",
            params![old["id"].as_str(), at(0)]).unwrap();
    }
    fill(&s, &task(&s, "T-1"), 10, LIMIT - 1);
    submit(&s, "new").unwrap();
    assert!(!exists(&s, old["id"].as_str().unwrap()));
    let error = submit(&s, "old").unwrap_err().to_string();
    assert!(error.contains("which was removed from the Job history") && error.contains("new requestId"), "{error}");
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), TARGET + 1);
}

#[test]
fn a_retry_of_a_settled_run_at_the_limit_keeps_that_run() {
    let (_dir, s) = setup();
    let t1 = task(&s, "T-1");
    let (previous, run_id);
    {
        let db = s.db.write().unwrap();
        let id = row(&db, &t1, "failed", 1, json!({"requestId":"stage","run":{"stage":"s","attempt":1}}));
        run_id = run(&db, &t1, Some(2), &[], std::slice::from_ref(&id));
        db.execute("UPDATE local_jobs SET data=json_set(data,'$.run.id',?2) WHERE id=?1", params![id, run_id]).unwrap();
        previous = super::store::get(&db, &id).unwrap();
    }
    fill(&s, &t1, 100, LIMIT - 1);
    let mut db = s.db.write().unwrap();
    let tx = db.transaction().unwrap();
    let next = super::runs::new_attempt(&tx, &previous, 2).unwrap();
    tx.commit().unwrap();
    drop(db);
    assert!(exists(&s, previous["id"].as_str().unwrap()));
    assert!(exists(&s, next["id"].as_str().unwrap()));
    assert_eq!(count(&s, &format!("SELECT COUNT(*) FROM local_job_run_attempts WHERE run_id='{run_id}'")), 2);
    assert_eq!(count(&s, "SELECT COUNT(*) FROM local_jobs"), TARGET + 1);
    assert_eq!(orphans(&s), 0);
}

#[test]
fn only_the_removed_jobs_own_folders_go_and_a_link_is_not_followed() {
    let data = tempfile::tempdir().unwrap();
    let root = data.path().join("jobs");
    std::fs::create_dir_all(&root).unwrap();
    let folder = |id: &str| {
        let dir = root.join(id);
        std::fs::create_dir_all(dir.join("logs")).unwrap();
        std::fs::write(dir.join("logs/log.txt"), "log").unwrap();
        dir
    };
    let removed = uuid::Uuid::new_v4().to_string();
    let kept = uuid::Uuid::new_v4().to_string();
    let orphan = uuid::Uuid::new_v4().to_string();
    let absent = uuid::Uuid::new_v4().to_string();
    let linked = uuid::Uuid::new_v4().to_string();
    for id in [&removed, &kept, &orphan] {
        folder(id);
    }
    std::fs::write(root.join("host-abc.py"), "helper").unwrap();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("precious.txt"), "keep").unwrap();
    std::os::unix::fs::symlink(outside.path(), root.join(&linked)).unwrap();
    let named = vec![removed.clone(), absent.clone(), linked.clone(), "../escape".into(), removed.to_uppercase()];
    let done = history::remove_folders_in(data.path(), &named);
    assert_eq!(done, named, "each is settled, removed or not");
    assert!(!root.join(&removed).exists());
    assert!(root.join(&kept).join("logs/log.txt").exists());
    assert!(root.join(&orphan).join("logs/log.txt").exists(), "no orphan scan");
    assert!(root.join("host-abc.py").exists());
    assert!(std::fs::symlink_metadata(root.join(&linked)).unwrap().file_type().is_symlink());
    assert!(outside.path().join("precious.txt").exists());
}

#[test]
fn the_pending_folders_are_read_and_forgotten() {
    let (_dir, s) = setup();
    let ids = fill(&s, &task(&s, "T-1"), 0, LIMIT);
    submit(&s, "new").unwrap();
    let pending = s.pruned_folders().unwrap();
    let mut first: Vec<String> = ids[..(LIMIT - TARGET) as usize].to_vec();
    first.sort();
    assert_eq!(pending, first);
    s.forget_pruned_folders(&pending).unwrap();
    assert!(s.pruned_folders().unwrap().is_empty());
}
