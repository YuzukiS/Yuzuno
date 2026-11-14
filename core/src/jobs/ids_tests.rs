//! T-30: job_get, job_logs, job_cancel and job_provenance name a Job or run,
//! and (YN-30) job_run_get, job_run_retry, job_run_decide and job_run_cancel
//! a run, by its whole ID or by a unique prefix of at least eight hexadecimal
//! characters, and a prefix that names none or several says which without
//! listing them. Synthetic records only.
use super::ids::Kind;
use super::*;
use crate::{model::AgentDetail, store::Store};
use rusqlite::params;

const A: &str = "1234abcd-0000-4000-8000-00000000000a";
const B: &str = "1234abcd-0000-4000-8000-00000000000b";
const C: &str = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

fn setup() -> (tempfile::TempDir, Arc<Workspace>) {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::new(dir.path().join("data"), "/workspace".into(), "unused".into()).unwrap();
    let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"Mori","cwd":"/workspace","model":"test","color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    ws.store.insert(&agent).unwrap();
    ws.store.collaboration_call(None, "task_create", json!({"requestId":"task","title":"Research outcome","status":"doing"})).unwrap();
    (dir, ws)
}

/// Finished Jobs (`jobs`) and runs with these IDs; the resolver reads only the ID.
fn rows(s: &Store, jobs: &[&str], runs: &[&str]) {
    let db = s.db.write().unwrap();
    let task = crate::collaboration_store::task_key(&db, "T-1").unwrap().0;
    for id in jobs {
        db.execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'a','succeeded',?3)",
            params![id, task, json!({"id":id,"status":"succeeded"}).to_string()]).unwrap();
    }
    for id in runs {
        db.execute("INSERT INTO local_job_runs(id,task_id,agent_id,data) VALUES(?1,?2,'a',?3)",
            params![id, task, json!({"id":id,"stages":[]}).to_string()]).unwrap();
    }
}

fn resolve(s: &Store, kind: Kind, given: &str) -> Result<String, String> {
    s.resolve_id(kind, given).map_err(|e| e.to_string())
}

#[test]
fn a_whole_id_or_a_unique_prefix_names_one_job() {
    let (_dir, ws) = setup();
    let s = &ws.store;
    rows(s, &[A, B, C, "fixture-job"], &[]);
    for given in [C, "9f8e7d6c", "9f8e7d6c-5b4a", "9F8E7D6C-5B", " 9f8e7d6c "] {
        assert_eq!(resolve(s, Kind::Job, given).as_deref(), Ok(C), "{given:?}");
    }
    // A whole ID is itself even where its start is shared, and an ID that is
    // not a UUID is still found whole, as before.
    assert_eq!(resolve(s, Kind::Job, A).as_deref(), Ok(A));
    assert_eq!(resolve(s, Kind::Job, B).as_deref(), Ok(B));
    assert_eq!(resolve(s, Kind::Job, "fixture-job").as_deref(), Ok("fixture-job"));
}

#[test]
fn a_shared_prefix_is_ambiguous_and_names_none_of_its_ids() {
    let (_dir, ws) = setup();
    let s = &ws.store;
    rows(s, &[A, B, C], &[]);
    for given in ["1234abcd", "1234ABCD-0000", "1234abcd-0000-4000-8000-00000000000"] {
        let error = resolve(s, Kind::Job, given).unwrap_err();
        assert!(error.contains("is ambiguous (2 matches)"), "{error}");
        assert!(!error.contains("not found"), "{error}");
        for id in [A, B, C] {
            assert!(!error.contains(id), "{id} in {error}");
        }
    }
}

#[test]
fn a_short_prefix_is_refused_even_when_it_names_one_job() {
    let (_dir, ws) = setup();
    let s = &ws.store;
    rows(s, &[C], &[]);
    for given in ["9f8e7d6", "9f8e-7d6", "--------", ""] {
        let error = resolve(s, Kind::Job, given).unwrap_err();
        assert!(error.contains("is too short: give at least 8 of its hexadecimal characters"), "{given:?}: {error}");
        assert!(!error.contains(C), "{error}");
    }
}

#[test]
fn a_prefix_of_no_id_is_not_found_and_not_ambiguous() {
    let (_dir, ws) = setup();
    let s = &ws.store;
    rows(s, &[A, B, C], &[]);
    let error = resolve(s, Kind::Job, "deadbeef").unwrap_err();
    assert_eq!(error, r#"Job not found: no Job ID starts with "deadbeef""#);
    for given in ["job-one", "9f8e7d6c-zz", "1234abcd 0000"] {
        let error = resolve(s, Kind::Job, given).unwrap_err();
        assert!(error.starts_with("Job not found: "), "{given:?}: {error}");
        assert!(!error.contains("ambiguous"), "{error}");
    }
}

#[test]
fn a_run_prefix_is_matched_among_runs_alone() {
    let (_dir, ws) = setup();
    let s = &ws.store;
    rows(s, &[B], &[A, C]);
    assert_eq!(resolve(s, Kind::Run, "9f8e7d6c").as_deref(), Ok(C));
    assert_eq!(resolve(s, Kind::Run, C).as_deref(), Ok(C));
    // A and B share a start, but only A is a run and only B a Job.
    assert_eq!(resolve(s, Kind::Run, "1234abcd").as_deref(), Ok(A));
    assert_eq!(resolve(s, Kind::Job, "1234abcd").as_deref(), Ok(B));
    assert_eq!(resolve(s, Kind::Run, B).unwrap_err(), format!("Run not found: no Run ID starts with {B:?}"));
    assert!(resolve(s, Kind::Run, "9f8e7d6").unwrap_err().starts_with("Run ID prefix \"9f8e7d6\" is too short"));
    rows(s, &[], &["1234abcd-ffff-4fff-8fff-ffffffffffff"]);
    let error = resolve(s, Kind::Run, "1234ABCD").unwrap_err();
    assert_eq!(error, r#"Run ID prefix "1234abcd" is ambiguous (2 matches): give more of it, or the whole ID"#);
}

#[tokio::test]
async fn job_get_logs_cancel_and_provenance_take_a_prefix() {
    let (_dir, ws) = setup();
    let s = &ws.store;
    // One run of one stage, finished, as provenance_tests makes it.
    let input: runs::RunSubmit = serde_json::from_value(json!({"requestId":"run","taskId":"T-1","name":"Fixture run",
        "stages":[{"key":"train","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0}}]})).unwrap();
    let prepared = input.stages.iter().map(|stage| {
        let submit = input.submit(stage);
        let snapshot = json!({"cwd":"/workspace","git":null,"files":[]});
        let identity = runs::spec_identity(&submit, &snapshot, stage.needs());
        runs::Prepared { submit, snapshot, identity, reuse: None, guard_exclude: vec![] }
    }).collect();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}});
    let run = s.create_run(Some("a"), input, prepared, machine, json!({"bootId":"boot"})).unwrap();
    let job = s.reserve_next_job(None, None, None).unwrap().unwrap();
    let evidence = json!({"jobId":job["id"],"attempt":job["attempt"],"status":"succeeded","reason":"Exit 0",
        "evidence":{"systemd":{"Result":"success","ExecMainCode":"1","ExecMainStatus":"0"}}});
    assert!(s.update_job_evidence(job["id"].as_str().unwrap(), evidence).unwrap());
    let (job_id, run_id) = (job["id"].as_str().unwrap().to_owned(), run["id"].as_str().unwrap().to_owned());
    let (short, run_short) = (job_id[..8].to_owned(), run_id[..8].to_owned());
    let tool = |name: &str, input: Value| call(ws.clone(), Some("a".into()), name.into(), input);

    assert_eq!(tool("job_get", json!({"jobId":short})).await.unwrap()["id"], job_id.as_str());
    assert_eq!(tool("job_logs", json!({"jobId":short})).await.unwrap()["jobId"], job_id.as_str());
    // A finished Job is left as it was; the prefix found it.
    let cancelled = tool("job_cancel", json!({"jobId":short})).await.unwrap();
    assert_eq!((cancelled["id"].as_str(), cancelled["status"].as_str()), (Some(job_id.as_str()), Some("succeeded")));
    let by_job = tool("job_provenance", json!({"jobId":short})).await.unwrap();
    assert_eq!(by_job["manifest"]["scope"]["id"], job_id.as_str());
    let by_run = tool("job_provenance", json!({"runId":run_short})).await.unwrap();
    assert_eq!((by_run["manifest"]["scope"]["kind"].as_str(), by_run["manifest"]["scope"]["id"].as_str()),
        (Some("run"), Some(run_id.as_str())));

    // A second Job that starts as this one does: its prefix is ambiguous to
    // every tool, and the whole ID still names it.
    let sibling = format!("{short}-0000-4000-8000-000000000000");
    assert_ne!(sibling, job_id);
    rows(s, &[&sibling], &[]);
    for (name, input) in [("job_get", json!({"jobId":short})), ("job_logs", json!({"jobId":short})),
        ("job_cancel", json!({"jobId":short})), ("job_provenance", json!({"jobId":short}))] {
        let error = tool(name, input).await.unwrap_err().to_string();
        assert!(error.contains("is ambiguous (2 matches)"), "{name}: {error}");
        assert!(!error.contains(&job_id) && !error.contains(&sibling), "{name}: {error}");
    }
    assert_eq!(tool("job_get", json!({"jobId":job_id})).await.unwrap()["id"], job_id.as_str());
    let error = tool("job_provenance", json!({"runId":&job_id[..7]})).await.unwrap_err().to_string();
    assert!(error.contains("Run ID prefix") && error.contains("is too short"), "{error}");

    let definitions = tool_definitions();
    for name in ["job_get", "job_logs", "job_cancel", "job_provenance"] {
        let tool = definitions.iter().find(|t| t["name"] == name).unwrap();
        let text = tool["inputSchema"]["properties"]["jobId"]["description"].as_str().unwrap();
        assert!(text.contains("unique prefix") && text.contains("at least 8"), "{name}: {text}");
    }
    let provenance = definitions.iter().find(|t| t["name"] == "job_provenance").unwrap();
    assert!(provenance["inputSchema"]["properties"]["runId"]["description"].as_str().unwrap().contains("unique prefix"));
}

/// YN-30: job_run_get, job_run_retry, job_run_decide and job_run_cancel name
/// a run as the Job tools do. A retry or decision made by a prefix is kept
/// with the whole ID, so its repeat by either is the same request.
#[cfg(target_os = "linux")]
#[tokio::test]
async fn the_run_tools_take_a_prefix_and_keep_the_whole_id() {
    let (_dir, ws) = setup();
    // No scheduler: these calls move the run themselves.
    ws.jobs.started.set(()).unwrap();
    let s = &ws.store;
    // Two independent stages: train waits for analysis after it succeeds,
    // prep fails and can be retried.
    let input: runs::RunSubmit = serde_json::from_value(json!({"requestId":"run","taskId":"T-1","name":"Fixture run",
        "stages":[{"key":"train","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0},"waitForAnalysis":true},
            {"key":"prep","cwd":"/workspace","argv":["/usr/bin/true"],"resources":{"cpuMillis":200,"memoryMiB":64,"swapMiB":0}}]})).unwrap();
    let prepared = input.stages.iter().map(|stage| {
        let submit = input.submit(stage);
        let snapshot = json!({"cwd":"/workspace","git":null,"files":[]});
        let identity = runs::spec_identity(&submit, &snapshot, stage.needs());
        runs::Prepared { submit, snapshot, identity, reuse: None, guard_exclude: vec![] }
    }).collect();
    let machine = json!({"id":"local-test","name":"test","suggestedBudget":{"cpuMillis":600,"memoryMiB":192,"swapMiB":0}});
    let run = s.create_run(Some("a"), input, prepared, machine, json!({"bootId":"boot"})).unwrap();
    for _ in 0..2 {
        let job = s.reserve_next_job(None, None, None).unwrap().unwrap();
        let (status, result, code) = if job["run"]["stage"] == "train" { ("succeeded", "success", "0") } else { ("failed", "exit-code", "1") };
        assert!(s.update_job_evidence(job["id"].as_str().unwrap(), json!({"jobId":job["id"],"attempt":job["attempt"],"status":status,
            "reason":result,"evidence":{"systemd":{"Result":result,"ExecMainCode":"1","ExecMainStatus":code}}})).unwrap());
    }
    let run_id = run["id"].as_str().unwrap().to_owned();
    let short = run_id[..8].to_owned();
    let tool = |name: &str, input: Value| call(ws.clone(), Some("a".into()), name.into(), input);
    let stage = |run: &Value, key: &str| run["stages"].as_array().unwrap().iter().find(|s| s["key"] == key).unwrap().clone();

    // Found: a unique prefix names the run, in any case and with its hyphen.
    let read = tool("job_run_get", json!({"runId":short})).await.unwrap();
    assert_eq!(read["id"], run_id.as_str());
    assert_eq!(tool("job_run_get", json!({"runId":run_id[..13].to_uppercase()})).await.unwrap()["id"], run_id.as_str());
    let gate = stage(&read, "train")["analysis"].clone();
    assert_eq!(gate["state"], "waiting", "{read}");

    let retried = tool("job_run_retry", json!({"requestId":"retry","runId":short,"stage":"prep"})).await.unwrap();
    assert_eq!((retried["id"].as_str(), stage(&retried, "prep")["attempts"].as_array().map(Vec::len)), (Some(run_id.as_str()), Some(2)));
    // Its repeat, by the whole ID or by the prefix, is the same retry: no third attempt.
    for given in [run_id.as_str(), short.as_str()] {
        let again = tool("job_run_retry", json!({"requestId":"retry","runId":given,"stage":"prep"})).await.unwrap();
        assert_eq!(stage(&again, "prep")["attempts"].as_array().map(Vec::len), Some(2), "{given}");
    }

    let decide = |run: &str| json!({"requestId":"go-on","runId":run,"stage":"train","gateId":gate["id"],"attemptId":gate["attemptId"],
        "decision":"continue","reason":"Read the retained evidence"});
    let decided = tool("job_run_decide", decide(&short)).await.unwrap();
    assert_eq!(stage(&decided, "train")["analysis"]["state"], "continued", "{decided}");
    // The same decision by the whole ID is its repeat, not a conflict.
    let again = tool("job_run_decide", decide(&run_id)).await.unwrap();
    assert_eq!(stage(&again, "train")["analysis"]["requestId"], "go-on");

    // Ambiguous: another run that starts as this one does. No tool picks one,
    // names either, or writes anything; the whole ID and a longer prefix still name it.
    let other = if &run_id[9..13] == "0000" { "ffff" } else { "0000" };
    let sibling = format!("{short}-{other}-4000-8000-000000000000");
    rows(s, &[], &[&sibling]);
    let before = tool("job_run_get", json!({"runId":run_id})).await.unwrap();
    for (name, input) in [("job_run_get", json!({"runId":short})),
        ("job_run_retry", json!({"requestId":"retry-2","runId":short,"stage":"prep"})),
        ("job_run_decide", decide(&short)),
        ("job_run_cancel", json!({"runId":short}))] {
        let error = tool(name, input).await.unwrap_err().to_string();
        assert_eq!(error, format!("Run ID prefix {short:?} is ambiguous (2 matches): give more of it, or the whole ID"), "{name}");
        assert!(!error.contains(&run_id) && !error.contains(&sibling), "{name}: {error}");
    }
    assert_eq!(tool("job_run_get", json!({"runId":run_id})).await.unwrap(), before, "nothing changed");

    // Not found, and too short: told apart, and nothing written.
    for (given, expected) in [("deadbeef", r#"Run not found: no Run ID starts with "deadbeef""#.to_owned()),
        (&run_id[..7], format!("Run ID prefix {:?} is too short: give at least 8 of its hexadecimal characters, or the whole ID", &run_id[..7])),
        ("fixture-run", r#"Run not found: "fixture-run" is neither a Run ID nor the start of one"#.to_owned())] {
        for (name, input) in [("job_run_get", json!({"runId":given})),
            ("job_run_retry", json!({"requestId":"retry-3","runId":given,"stage":"prep"})),
            ("job_run_decide", decide(given)),
            ("job_run_cancel", json!({"runId":given}))] {
            assert_eq!(tool(name, input).await.unwrap_err().to_string(), expected, "{name} {given:?}");
        }
    }
    assert_eq!(tool("job_run_get", json!({"runId":run_id})).await.unwrap(), before, "nothing changed");
    // A Job's ID is not a run's.
    let job_id = stage(&before, "prep")["attempts"][0]["id"].as_str().unwrap().to_owned();
    assert!(tool("job_run_cancel", json!({"runId":&job_id[..8]})).await.unwrap_err().to_string().starts_with("Run not found"));

    let cancelled = tool("job_run_cancel", json!({"runId":run_id[..13]})).await.unwrap();
    assert_eq!(cancelled["id"], run_id.as_str());
    assert!(cancelled["cancelRequestedAt"].is_string(), "{cancelled}");

    let definitions = tool_definitions();
    for name in ["job_run_get", "job_run_retry", "job_run_decide", "job_run_cancel"] {
        let tool = definitions.iter().find(|t| t["name"] == name).unwrap();
        let text = tool["inputSchema"]["properties"]["runId"]["description"].as_str().unwrap();
        assert!(text.starts_with("The run's ID, or a unique prefix of it: at least 8"), "{name}: {text}");
    }
}
