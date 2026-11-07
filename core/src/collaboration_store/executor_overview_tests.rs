use super::{overview, step_states, Facts};
use crate::executor_lifecycle::tests::{role, task, task_is};
use crate::{github::client::Repository, model::AgentDetail, store::Store};
use rusqlite::params;
use serde_json::{json, Value};

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    (dir, store)
}

fn agent(store: &Store, id: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
        "model":"","harness":"codex","color":"sage","status":"idle","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
}

/// A `pr` template's default steps, its review two rounds.
fn pr_steps() -> Vec<Value> {
    ["materials", "work", "job", "pr", "review", "ci", "merge"]
        .iter()
        .map(|kind| if *kind == "review" { json!({"kind":kind,"rounds":2}) } else { json!({"kind":kind}) })
        .collect()
}

fn states(steps: &[Value], facts: &Facts) -> Vec<String> {
    step_states(steps, facts).iter().map(|s| format!("{}:{}", s["kind"].as_str().unwrap(), s["state"].as_str().unwrap())).collect()
}

fn pull(state: &str, ci: &str, review: Option<(&str, &str, bool)>) -> Value {
    let mut p = json!({"number":688,"url":"https://github.com/owner/repo/pull/688","state":state,"repositoryId":7,
        "headSha":"2".repeat(40),"ci":{"state":ci,"headSha":"2".repeat(40)}});
    if let Some((status, conclusion, current)) = review {
        p["latestReview"] = json!({"reviewId":"r1","round":1,"status":status,"conclusion":conclusion,"forCurrentHead":current});
    }
    p
}

/// T-43 S3: each step's state from its record, as an executor goes from its
/// mail to its merge: read → Job → PR → review → CI → merge.
#[test]
fn steps_follow_the_executors_records_from_its_mail_to_its_merge() {
    let steps = pr_steps();
    let mut facts = Facts { lifecycle: "starting".into(), ..Facts::default() };
    assert!(states(&steps, &facts).iter().all(|s| s.ends_with(":todo")), "nothing begun: {:?}", states(&steps, &facts));
    facts.lifecycle = "running".into();
    facts.read_at = Some("2026-11-07T10:00:00Z".into());
    assert_eq!(states(&steps, &facts)[..3], ["materials:done", "work:doing", "job:todo"]);
    // Its Job: running, then succeeded; the newest Job decides.
    facts.jobs = vec![json!({"id":"j2","name":"tests","status":"running"})];
    assert_eq!(states(&steps, &facts)[2], "job:doing");
    facts.jobs = vec![json!({"id":"j3","name":"tests","status":"failed"}), json!({"id":"j2","status":"succeeded"})];
    assert_eq!(states(&steps, &facts)[2], "job:failed", "the newest Job failed");
    facts.jobs.insert(0, json!({"id":"j4","name":"tests","status":"succeeded"}));
    let read = step_states(&steps, &facts);
    assert_eq!((read[2]["state"].clone(), read[2]["ref"]["id"].clone()), (json!("done"), json!("j4")));
    // The PR in: work is done; a review in progress, then passed; CI green; merged.
    facts.pull = Some(pull("open", "pending", Some(("running", "unknown", true))));
    assert_eq!(states(&steps, &facts)[1..], ["work:done", "job:done", "pr:done", "review:doing", "ci:doing", "merge:todo"]);
    facts.pull = Some(pull("open", "success", Some(("completed", "no_findings", true))));
    facts.merge = Some(json!({"id":"m1","state":"merging"}));
    assert_eq!(states(&steps, &facts)[4..], ["review:done", "ci:done", "merge:doing"]);
    facts.merge = Some(json!({"id":"m1","state":"merged"}));
    let done = step_states(&steps, &facts);
    assert!(done.iter().all(|s| s["state"] == "done"), "every step done: {done:?}");
    assert_eq!(done[3]["ref"], json!({"kind":"pr","number":688,"url":"https://github.com/owner/repo/pull/688","state":"open"}));
    assert_eq!(done[6]["ref"]["id"], "m1");
    assert_eq!(done[4]["rounds"], 2, "the template's own fields stay");
}

#[test]
fn a_failing_record_fails_its_step_and_an_earlier_heads_review_is_not_this_ones() {
    let steps = pr_steps();
    let facts = |pull: Value, merge: Option<Value>| Facts { lifecycle: "delivering".into(), pull: Some(pull), merge, ..Facts::default() };
    let read = states(&steps, &facts(pull("open", "failure", Some(("completed", "changes_requested", true))), None));
    assert_eq!(read[4..6], ["review:failed", "ci:failed"]);
    // A review of an earlier head says nothing of this head's.
    assert_eq!(states(&steps, &facts(pull("open", "success", Some(("completed", "no_findings", false))), None))[4], "review:todo");
    assert_eq!(states(&steps, &facts(pull("open", "success", None), Some(json!({"id":"m","state":"stopped"}))))[6], "merge:failed");
    // Merged on GitHub without an entry (merged by hand): done.
    assert_eq!(states(&steps, &facts(pull("merged", "success", None), None))[6], "merge:done");
    // Its materials were read once anything after them began, a read recorded or not.
    assert_eq!(states(&steps, &facts(pull("open", "unknown", None), None))[0], "materials:done");
}

#[test]
fn a_gate_blocks_while_it_waits_and_passes_once_a_later_step_begins() {
    let steps: Vec<Value> = ["materials", "work", "result", "gate", "work", "result"].iter().map(|k| json!({"kind":k})).collect();
    let mut facts = Facts { lifecycle: "running".into(), read_at: Some("t".into()), waiting: true,
        result: Some(json!({"id":"res","reportedAt":"t"})), ..Facts::default() };
    let read = states(&steps, &facts);
    assert_eq!(read[2..4], ["result:done", "gate:blocked"]);
    facts.waiting = false;
    // Answered: the gate isn't waiting; it passed once work after it begins.
    assert_eq!(states(&steps, &facts)[3], "gate:done", "the result after it is in: {:?}", states(&steps, &facts));
}

/// The route's read: none for another Agent; an executor's lifecycle, task,
/// steps (its delivery mode's when its dispatch kept no template), PR with
/// its diff size, CI, review and its own Jobs.
#[test]
fn an_executors_overview_reads_its_task_pr_and_jobs_and_another_agent_has_none() {
    let (_dir, s) = store();
    agent(&s, "plain");
    assert!(overview(&s.db.read().unwrap(), "plain", false).unwrap().is_none(), "not an executor");
    assert!(overview(&s.db.read().unwrap(), "missing", false).unwrap().is_none());

    let (public, internal) = task(&s, "Overview work");
    agent(&s, "e1");
    role(&s, "e1", &internal, "user", "d-e1", "running", None);
    let head = "2".repeat(40);
    let repo = Repository { id: 7, full_name: "owner/repo".into() };
    s.github_link_object(&public, &repo, "pull", 688, json!({"title":"PR 688","state":"open","baseSha":"a".repeat(40),
        "headSha":head,"baseBranch":"main","ci":{"state":"success","headSha":head},
        "changes":{"additions":120,"deletions":30,"files":7}})).unwrap();
    {
        let db = s.db.write().unwrap();
        for (seq, id, agent, status) in [(1, "j1", "e1", "failed"), (2, "j2", "e1", "succeeded"), (3, "j9", "someone", "running")] {
            db.execute("INSERT INTO local_jobs(seq,id,task_id,agent_id,status,data) VALUES(?1,?2,?3,?4,?5,?6)",
                params![seq, id, internal, agent, status, json!({"id":id,"name":format!("job {id}"),"status":status}).to_string()]).unwrap();
        }
    }
    task_is(&s, &internal, "doing", "", Some("d-e1"));
    let read = overview(&s.db.read().unwrap(), "e1", false).unwrap().expect("an executor");
    assert_eq!(read["task"], json!({"id":public,"title":"Overview work","status":"doing"}));
    assert_eq!(read["lifecycle"]["state"], "running");
    assert!(read["materials"].is_null(), "this dispatch kept no materials");
    let kinds: Vec<&str> = read["steps"].as_array().unwrap().iter().map(|s| s["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["materials", "work", "job", "pr", "review", "ci", "merge"], "a pr template's steps");
    assert_eq!(read["pullRequest"]["number"], 688);
    assert_eq!(read["pullRequest"]["changes"], json!({"additions":120,"deletions":30,"files":7}), "its diff's size");
    // Only its own Jobs, newest first.
    let jobs: Vec<&str> = read["jobs"].as_array().unwrap().iter().map(|j| j["id"].as_str().unwrap()).collect();
    assert_eq!(jobs, ["j2", "j1"]);
    let state = |kind: &str| read["steps"].as_array().unwrap().iter().find(|s| s["kind"] == kind).unwrap()["state"].clone();
    assert_eq!([state("job"), state("pr"), state("ci"), state("merge")], [json!("done"), json!("done"), json!("done"), json!("todo")]);
    // Its result on this dispatch is its own.
    assert_eq!(read["result"]["reportedAt"], "2026-11-06T02:00:00Z");
    // Waiting, as its listing says: no gate here, but the work isn't going on.
    let waiting = overview(&s.db.read().unwrap(), "e1", true).unwrap().unwrap();
    assert_eq!(waiting["steps"][1]["state"], "done", "its PR is in");
}
