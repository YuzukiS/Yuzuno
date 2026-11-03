//! Research records (T-17), with synthetic tasks, Jobs and agents only.
use super::*;
use crate::model::AgentDetail;

const ATTEMPT: &str = "11111111-1111-4111-8111-111111111111";
const LATER_ATTEMPT: &str = "33333333-3333-4333-8333-333333333333";

fn setup() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    for id in ["author", "other"] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),
            "cwd":"/synthetic/work","model":"test","color":"sage","threadId":format!("session-{id}"),
            "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        store.insert(&agent).unwrap();
    }
    for (key, title) in [("one", "Is the new layout faster? (synthetic)"), ("two", "A neighbouring study (synthetic)")] {
        store.collaboration_call(None, "task_create", json!({"requestId":key,"title":title})).unwrap();
    }
    job(&store, "T-1", "job-1", ATTEMPT, "a");
    job(&store, "T-2", "job-2", ATTEMPT, "b");
    (dir, store)
}

/// A finished Job of `task` whose check recorded out/timings.json with the
/// SHA-256 `hex` repeated.
fn job(store: &Store, task: &str, id: &str, attempt: &str, hex: &str) {
    let task = task_key(&store.db.read().unwrap(), task).unwrap().0;
    let data = json!({"id":id,"taskId":task,"agentId":"author","attempt":attempt,"status":"succeeded",
        "cwd":"/synthetic/does-not-exist","machine":{"name":"Synthetic host"},"finishedAt":"2026-11-01T00:00:00Z",
        "result":{"attempt":attempt,"artifacts":[{"path":"out/timings.json","sha256":hex.repeat(64),
            "ok":true,"bytes":40}]}});
    store.db.write().unwrap().execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'author','succeeded',?3)",
        params![id,task,data.to_string()]).unwrap();
}

fn comment(store: &Store, actor: &str, key: &str, task: &str, research: Value) -> Result<Value> {
    store.collaboration_call(Some(actor), "task_comment",
        json!({"requestId":key,"taskId":task,"body":format!("Note {key}"),"research":research}))
}

fn seq(answer: &Value) -> i64 {
    answer["activity"]["seq"].as_i64().unwrap()
}

fn record(store: &Store, task: &str, seq: i64) -> Value {
    store.collaboration_call(Some("author"), "task_research_get", json!({"taskId":task,"activitySeq":seq})).unwrap()
}

/// (task version, its status, activities, receipts, mail) across the Workspace.
fn counts(store: &Store) -> (i64, String, i64, i64, i64) {
    store.db.read().unwrap().query_row("SELECT (SELECT version FROM collaboration_tasks WHERE seq=1),
        (SELECT json_extract(data,'$.status') FROM collaboration_tasks WHERE seq=1),
        (SELECT COUNT(*) FROM collaboration_task_activity),(SELECT COUNT(*) FROM collaboration_requests),
        (SELECT COUNT(*) FROM collaboration_messages)", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap()
}

fn method(id: &str, text: &str) -> Value {
    json!({"type":"method","id":id,"title":"Timing protocol","text":text,"field":"systems",
        "limits":["One machine; no cross-machine run yet"]})
}

fn job_source(attempt: &str, hex: &str) -> Value {
    json!({"kind":"job","label":"Raw timings","jobId":"job-1","attempt":attempt,"path":"out/timings.json","sha256":hex.repeat(64)})
}

fn claim(method: i64, sources: Value) -> Value {
    json!({"type":"claim","id":"faster","title":"Layout B is faster on the small inputs",
        "text":"Layout B runs the small inputs about 4% faster than layout A.","status":"conditional",
        "conditions":["Small inputs only","Process-level repeats, not iterations"],
        "method":{"activitySeq":method},"sources":sources})
}

fn error(result: Result<Value>) -> String {
    result.unwrap_err().to_string()
}

#[test]
fn a_record_is_a_comment_that_changes_nothing_else_and_reads_back_with_its_sources() {
    let (_dir, store) = setup();
    let before = counts(&store);
    let m1 = seq(&comment(&store, "author", "m1", "T-1", method("timing", "Time each build in a fresh process; 10 processes.")).unwrap());
    let external = json!({"kind":"external","label":"Upstream benchmark notes","url":"https://example.org/bench",
        "version":"v3","observedAt":"2026-11-01","coverage":"Small inputs only; the large set was not exported"});
    let answer = comment(&store, "author", "c1", "T-1", claim(m1, json!([job_source(ATTEMPT, "a"), external]))).unwrap();
    let c1 = seq(&answer);
    // The task, its result and its mail are as they were: two comments more.
    let after = counts(&store);
    assert_eq!((after.0, after.1.clone(), after.2, after.4), (before.0, before.1, before.2 + 2, before.4));
    assert!(answer["task"]["result"].is_null());
    let stored = &answer["activity"]["research"];
    assert_eq!((stored["schema"].clone(), stored["type"].clone(), stored["status"].clone()), (json!("research/1"), json!("claim"), json!("conditional")));
    assert_eq!(stored["method"], json!({"activitySeq":m1,"id":"timing","title":"Timing protocol"}));
    assert_eq!(stored["sources"][0]["recorded"], "recorded_match");
    assert_eq!(stored["sources"][0]["bytes"], 40);
    assert_eq!(stored["sources"][1]["checked"], false, "an external source is never checked");

    let read = record(&store, "T-1", c1);
    assert_eq!((read["taskId"].clone(), read["version"].clone(), read["latestActivitySeq"].clone()), (json!("T-1"), json!(1), json!(c1)));
    assert!(read["revisedBy"].is_null());
    assert_eq!(read["actor"]["id"], "author");
    assert_eq!(read["research"]["sources"][0]["now"]["state"], "recorded_match");
    assert_eq!(read["research"]["sources"][0]["now"]["file"], "not_read", "a record read is no claim that the file is there");
    assert_eq!(read["research"]["sources"][1]["now"], json!({"state":"stated"}));
    assert!(read["note"].as_str().unwrap().contains("whether the file can still be read is unknown"));
    assert_eq!((read["method"]["activitySeq"].clone(), read["method"]["version"].clone()), (json!(m1), json!(1)));
    assert_eq!(read["method"]["research"]["text"], "Time each build in a fresh process; 10 processes.");
    assert!(read["note"].as_str().unwrap().contains("not a verdict"));
    // The task's history carries the same record.
    let history = store.collaboration_call(None, "task_get", json!({"taskId":"T-1"})).unwrap();
    let shown = history["activities"].as_array().unwrap().iter().find(|a| a["seq"] == c1).unwrap();
    assert_eq!(shown["research"], answer["activity"]["research"]);
    // A plain comment is as it always was, and other activities gain no field.
    let plain = store.collaboration_call(Some("author"), "task_comment", json!({"requestId":"plain","taskId":"T-1","body":"Just a note"})).unwrap();
    assert!(plain["activity"].get("research").is_none());
    let history = store.collaboration_call(None, "task_get", json!({"taskId":"T-1"})).unwrap();
    assert!(history["activities"][0].get("research").is_none(), "the created activity: {}", history["activities"][0]);
    assert!(error(store.collaboration_call(Some("author"), "task_research_get", json!({"taskId":"T-1","activitySeq":seq(&plain)})))
        .starts_with("not_found:"));
}

#[test]
fn a_job_source_is_this_tasks_exact_attempt_and_file() {
    let (_dir, store) = setup();
    let m1 = seq(&comment(&store, "author", "m1", "T-1", method("timing", "Fresh process per run.")).unwrap());
    let before = counts(&store);
    // The wrong hash, the wrong attempt, and another task's Job: refused, nothing written.
    let wrong_hash = error(comment(&store, "author", "c-hash", "T-1", claim(m1, json!([job_source(ATTEMPT, "f")]))));
    assert!(wrong_hash.starts_with("invalid_input:") && wrong_hash.contains("artifact_mismatch") && wrong_hash.contains("research.sources[0]"), "{wrong_hash}");
    let wrong_attempt = error(comment(&store, "author", "c-attempt", "T-1", claim(m1, json!([job_source(LATER_ATTEMPT, "a")]))));
    assert!(wrong_attempt.contains("attempt_mismatch"), "{wrong_attempt}");
    let mut borrowed = job_source(ATTEMPT, "b");
    borrowed["jobId"] = json!("job-2");
    let foreign = error(comment(&store, "author", "c-foreign", "T-1", claim(m1, json!([borrowed]))));
    assert!(foreign.contains("job_missing"), "another task's Job is not this task's: {foreign}");
    assert_eq!(counts(&store), before);

    // A later attempt writes another file at the same path: the record keeps
    // the file it was made with, and the new file is a new reference.
    let c1 = seq(&comment(&store, "author", "c1", "T-1", claim(m1, json!([job_source(ATTEMPT, "a")]))).unwrap());
    job(&store, "T-1", "job-1b", LATER_ATTEMPT, "c");
    let read = record(&store, "T-1", c1);
    assert_eq!(read["research"]["sources"][0]["sha256"], "a".repeat(64));
    assert_eq!(read["research"]["sources"][0]["now"]["state"], "recorded_match");
    let mut renamed = job_source(LATER_ATTEMPT, "a");
    renamed["jobId"] = json!("job-1b");
    let mut later = claim(m1, json!([renamed]));
    later["revises"] = json!({"activitySeq":c1,"reason":"Rerun on the later attempt"});
    assert!(error(comment(&store, "author", "c2", "T-1", later)).contains("artifact_mismatch"), "the old hash is not the new file");
    // The Job record gone: the identity stays, its state now says so.
    store.db.write().unwrap().execute("DELETE FROM local_jobs WHERE id='job-1'", []).unwrap();
    let read = record(&store, "T-1", c1);
    assert_eq!((read["research"]["sources"][0]["recorded"].clone(), read["research"]["sources"][0]["now"]["state"].clone()),
        (json!("recorded_match"), json!("job_missing")));
}

#[test]
fn a_task_source_keeps_its_producer_and_never_becomes_this_tasks_artifact() {
    let (_dir, store) = setup();
    let observation = json!({"type":"observation","id":"ranking","title":"Ranking flips with link order",
        "text":"Reordering the link step reverses the ranking on two inputs."});
    let o1 = seq(&comment(&store, "other", "o1", "T-2", observation).unwrap());
    let cited = json!({"type":"claim","id":"narrow","title":"Only the small inputs","text":"The gain holds on small inputs only.",
        "status":"conditional","sources":[{"kind":"task","taskId":"T-2","activitySeq":o1}]});
    let answer = comment(&store, "author", "c1", "T-1", cited.clone()).unwrap();
    let source = &answer["activity"]["research"]["sources"][0];
    assert_eq!(source["taskId"], "T-2", "answers name tasks as T-n");
    assert_eq!((source["producer"]["id"].clone(), source["record"]["type"].clone()), (json!("other"), json!("observation")));
    assert!(source.get("recorded").is_none() && source.get("jobId").is_none(), "not a Job artifact of T-1");
    let read = record(&store, "T-1", seq(&answer));
    assert_eq!(read["research"]["sources"][0]["now"]["state"], "readable");
    // A retry naming T-2 by its UUID is the same request.
    let uuid = task_key(&store.db.read().unwrap(), "T-2").unwrap().0;
    let mut by_uuid = cited.clone();
    by_uuid["sources"][0]["taskId"] = json!(uuid);
    assert_eq!(comment(&store, "author", "c1", "T-1", by_uuid).unwrap(), answer);

    // Only a research record or a result can be cited, and only where it is.
    let plain = store.collaboration_call(Some("other"), "task_comment", json!({"requestId":"p","taskId":"T-2","body":"Plain"})).unwrap();
    let mut not_research = cited.clone();
    not_research["id"] = json!("other-claim");
    not_research["sources"][0]["activitySeq"] = json!(seq(&plain));
    assert!(error(comment(&store, "author", "c2", "T-1", not_research)).contains("neither a research record nor a result"));
    let mut elsewhere = cited.clone();
    elsewhere["id"] = json!("third-claim");
    elsewhere["sources"][0]["activitySeq"] = json!(seq(&answer));
    assert!(error(comment(&store, "author", "c3", "T-1", elsewhere)).contains("T-2 has no activity"), "an activity of T-1 is not T-2's");
    let mut unknown = cited;
    unknown["id"] = json!("fourth-claim");
    unknown["sources"][0]["taskId"] = json!("T-99");
    assert!(error(comment(&store, "author", "c4", "T-1", unknown)).starts_with("task_not_found:"));
}

#[test]
fn revisions_make_one_line_and_earlier_citations_keep_their_version() {
    let (_dir, store) = setup();
    let m1 = seq(&comment(&store, "author", "m1", "T-1", method("timing", "10 iterations in one process.")).unwrap());
    let c1 = seq(&comment(&store, "author", "c1", "T-1", claim(m1, json!([job_source(ATTEMPT, "a")]))).unwrap());
    let mut revised = method("timing", "10 fresh processes; iterations are not independent runs.");
    revised["revises"] = json!({"activitySeq":m1,"reason":"Iterations in one process share caches and layout."});
    let m2 = seq(&comment(&store, "author", "m2", "T-1", revised.clone()).unwrap());

    let first = record(&store, "T-1", m1);
    assert_eq!((first["version"].clone(), first["revisedBy"].clone(), first["latestActivitySeq"].clone()), (json!(1), json!(m2), json!(m2)));
    let second = record(&store, "T-1", m2);
    assert_eq!((second["version"].clone(), second["research"]["revises"]["reason"].clone()),
        (json!(2), json!("Iterations in one process share caches and layout.")));
    // The claim was made with version 1 and still says so.
    let made_with = record(&store, "T-1", c1)["method"].clone();
    assert_eq!((made_with["activitySeq"].clone(), made_with["version"].clone(), made_with["latestActivitySeq"].clone()), (json!(m1), json!(1), json!(m2)));
    assert_eq!(made_with["research"]["text"], "10 iterations in one process.");

    let before = counts(&store);
    // One line: version 1 is not revised twice; an id is revised, not reused.
    assert!(error(comment(&store, "author", "m3", "T-1", revised)).contains(&format!("already revised by activity {m2}")));
    assert!(error(comment(&store, "author", "m4", "T-1", method("timing", "Again."))).contains("already used in this task"));
    let mut no_reason = method("timing", "Again.");
    no_reason["revises"] = json!({"activitySeq":m2,"reason":"  "});
    assert!(error(comment(&store, "author", "m5", "T-1", no_reason)).contains("reason must not be empty"));
    let mut other_type = claim(m2, json!([]));
    other_type["id"] = json!("timing");
    other_type["revises"] = json!({"activitySeq":m2,"reason":"A claim now"});
    assert!(error(comment(&store, "author", "m6", "T-1", other_type)).contains("keeps its type and id"));
    assert_eq!(counts(&store), before);
}

#[test]
fn retries_conflicts_and_shapes() {
    let (_dir, store) = setup();
    let m1 = comment(&store, "author", "m1", "T-1", method("timing", "Fresh processes.")).unwrap();
    assert_eq!(comment(&store, "author", "m1", "T-1", method("timing", "Fresh processes.")).unwrap(), m1, "a retry answers as before");
    let before = counts(&store);
    assert!(error(comment(&store, "author", "m1", "T-1", method("timing", "Changed."))).starts_with("idempotency_conflict:"));
    let m1 = seq(&m1);
    let refused = [
        (json!({"type":"claim","id":"x","title":"T","text":"S"}), "needs research.status"),
        (json!({"type":"method","id":"y","title":"T","text":"S","status":"open"}), "for claims only"),
        (json!({"type":"method","id":"z","title":"T","text":"S","method":{"activitySeq":m1}}), "does not cite a method"),
        (json!({"type":"observation","id":"Bad Id","title":"T","text":"S"}), "research.id is"),
        (json!({"type":"observation","id":"w","title":"T","text":"S","method":{"activitySeq":m1 + 100}}), "not a method record"),
        (json!({"type":"observation","id":"v","title":"T","text":"S","sources":[{"kind":"external","label":"L","url":"ftp://x"}]}), "http or https"),
        (json!({"type":"observation","id":"u","title":"T","text":"S","sources":[{"kind":"external","url":"https://x"}]}), "needs a label"),
        (json!({"type":"observation","id":"t","title":"T","text":"S","sources":[{"kind":"file"}]}), "job, task or external"),
        (json!({"type":"observation","id":"s","title":"T","text":"S","sources":(0..21).map(|_| json!({"kind":"external","label":"L"})).collect::<Vec<_>>()}), "at most 20"),
        (json!({"type":"observation","id":"r","title":"T","text":"S","verdict":"true"}), "unknown field verdict"),
    ];
    for (n, (research, expected)) in refused.into_iter().enumerate() {
        let message = error(comment(&store, "author", &format!("bad-{n}"), "T-1", research));
        assert!(message.starts_with("invalid_input:") && message.contains(expected), "{n}: {message}");
    }
    assert_eq!(counts(&store), before, "nothing refused is written");
    // A theory claim needs no Job, seed or source.
    let proof = json!({"type":"claim","id":"bound","title":"The bound is tight","field":"theory","status":"open",
        "text":"No instance below n log n is known.","limits":["Finite enumeration up to n = 12 only; not a proof"]});
    assert!(comment(&store, "author", "proof", "T-1", proof).is_ok());
}

#[test]
fn a_desk_reads_a_task_record_by_the_same_resolver() {
    let (_dir, store) = setup();
    let m1 = seq(&comment(&store, "author", "m1", "T-1", method("timing", "Fresh processes.")).unwrap());
    let db = store.db.read().unwrap();
    let shown = desk_source(&db, "T-1", m1).unwrap();
    assert_eq!((shown["available"].clone(), shown["record"]["type"].clone(), shown["producer"]["id"].clone(), shown["version"].clone()),
        (json!(true), json!("method"), json!("author"), json!(1)));
    assert_eq!(shown["taskId"], "T-1");
    let created = db.query_row("SELECT seq FROM collaboration_task_activity WHERE json_extract(data,'$.kind')='created' ORDER BY seq LIMIT 1",
        [], |r| r.get::<_, i64>(0)).unwrap();
    assert_eq!(desk_source(&db, "T-1", created).unwrap()["reason"], "not_research");
    assert_eq!(desk_source(&db, "T-1", m1 + 1000).unwrap()["reason"], "activity_not_found");
    assert_eq!(desk_source(&db, "T-404", m1).unwrap()["reason"], "task_not_found");
}

/// A comparison (T-17 slice 2): layout B vs A timed two ways, one input set
/// missing and one never run.
fn comparison(m1: i64, m2: i64, entries: Value) -> Value {
    let _ = (m1, m2);
    json!({"type":"comparison","id":"layouts","title":"Layout B vs A, small inputs","field":"systems",
        "text":"Runtime change of layout B against A on the small inputs.","entries":entries})
}

fn entry(id: &str, status: &str, method: i64, unit: &str, level: &str) -> Value {
    json!({"id":id,"label":format!("Entry {id}"),"status":status,"method":{"activitySeq":method},
        "unit":unit,"level":level,"definition":"median of runs","n":10,"value":{"value":-4.1,"low":-6.0,"high":-2.2}})
}

#[test]
fn a_comparison_keeps_what_was_left_out_and_says_what_its_entries_share() {
    let (_dir, store) = setup();
    let m1 = seq(&comment(&store, "author", "m1", "T-1", method("timing", "Ten iterations in one process.")).unwrap());
    let mut revised = method("timing", "Ten fresh processes.");
    revised["revises"] = json!({"activitySeq":m1,"reason":"Iterations share caches."});
    let m2 = seq(&comment(&store, "author", "m2", "T-1", revised).unwrap());
    let mut sourced = entry("processes", "included", m2, "%", "process");
    sourced["source"] = job_source(ATTEMPT, "a");
    let entries = json!([
        sourced,
        entry("again", "included", m2, "%", "process"),
        {"id":"large","label":"Large inputs","status":"missing","reason":"The large set was not exported."},
        {"id":"other-machine","label":"Second machine","status":"not_done","reason":"No second machine yet."},
        {"id":"warm","label":"Warm cache run","status":"excluded","reason":"Cache left warm by a previous run.","value":{"value":-9.0}},
    ]);
    let answer = comment(&store, "author", "c1", "T-1", comparison(m1, m2, entries.clone())).unwrap();
    let stored = &answer["activity"]["research"];
    assert_eq!(stored["entries"].as_array().unwrap().len(), 5, "nothing left out is dropped");
    assert_eq!(stored["comparability"]["aligned"], true, "kept with the entries when written");
    assert_eq!(stored["entries"][0]["source"]["recorded"], "recorded_match");
    assert_eq!(stored["entries"][0]["method"]["activitySeq"], m2);
    let read = record(&store, "T-1", seq(&answer));
    let summary = &read["research"]["comparability"];
    assert_eq!(summary["aligned"], true, "{summary}");
    assert_eq!(summary["shared"], json!({"unit":"%","definition":"median of runs","level":"process","method":m2}));
    assert_eq!(summary["counts"], json!({"included":2,"excluded":1,"missing":1,"not_done":1}));
    assert_eq!(read["research"]["entries"][0]["source"]["now"]["state"], "recorded_match");
    assert!(read["research"]["entries"][0].get("difference").is_none() && summary.get("difference").is_none(), "no difference is computed");

    // Entries timed by different methods, in different units, one with no level: side by side only.
    let mut mixed = entries.as_array().unwrap().clone();
    mixed[1] = entry("iterations", "included", m1, "ms", "iteration");
    mixed[0]["level"] = Value::Null;
    let answer = comment(&store, "author", "c2", "T-1", {
        let mut record = comparison(m1, m2, json!(mixed));
        record["id"] = json!("layouts-mixed");
        record
    }).unwrap();
    let summary = record(&store, "T-1", seq(&answer))["research"]["comparability"].clone();
    assert_eq!(summary["aligned"], false);
    assert_eq!(summary["differs"], json!(["unit", "method"]));
    assert_eq!(summary["unknown"], json!(["level"]));

    // A Home desk citing the comparison sees its counts.
    let db = store.db.read().unwrap();
    let shown = desk_source(&db, "T-1", seq(&answer)).unwrap();
    assert_eq!((shown["record"]["type"].clone(), shown["record"]["counts"]["missing"].clone()), (json!("comparison"), json!(1)));
}

#[test]
fn a_comparison_entry_says_why_it_was_left_out_and_states_no_value_it_does_not_have() {
    let (_dir, store) = setup();
    let m1 = seq(&comment(&store, "author", "m1", "T-1", method("timing", "Fresh processes.")).unwrap());
    let before = counts(&store);
    let refused = [
        (json!([{"id":"a","label":"A","status":"excluded"}]), "excluded entry needs a reason"),
        (json!([{"id":"a","label":"A","status":"missing","reason":"Lost.","value":{"value":1.0}}]), "missing entry has no value"),
        (json!([{"id":"a","label":"A","status":"not_done","reason":"Later.","value":{"value":1.0}}]), "not_done entry has no value"),
        (json!([entry("a", "included", m1, "%", "process"), entry("a", "included", m1, "%", "process")]), "used twice"),
        (json!([{"id":"a","label":"A","status":"kept"}]), "status is one of"),
        (json!([{"id":"a","label":"A","status":"included","method":{"activitySeq":m1 + 100}}]), "not a method record"),
        (json!([{"id":"a","label":"A","status":"included","source":job_source(ATTEMPT, "f")}]), "artifact_mismatch"),
        (json!([]), "1 to 40"),
    ];
    for (n, (entries, expected)) in refused.into_iter().enumerate() {
        let mut record = comparison(m1, m1, entries);
        record["id"] = json!(format!("bad-{n}"));
        let message = error(comment(&store, "author", &format!("bad-{n}"), "T-1", record));
        assert!(message.starts_with("invalid_input:") && message.contains(expected), "{n}: {message}");
    }
    assert!(error(comment(&store, "author", "no-entries", "T-1",
        json!({"type":"comparison","id":"none","title":"T","text":"S"}))).contains("needs research.entries"));
    assert!(error(comment(&store, "author", "entries-on-claim", "T-1",
        json!({"type":"claim","id":"c","title":"T","text":"S","status":"open","entries":[{"id":"a","label":"A","status":"included"}]}))).contains("for comparisons only"));
    assert_eq!(counts(&store), before, "nothing refused is written");
}

#[test]
fn past_the_followed_length_a_line_says_its_newest_and_version_are_unknown() {
    let (_dir, store) = setup();
    let first = seq(&comment(&store, "author", "v0", "T-1", method("timing", "Version 0.")).unwrap());
    let mut previous = first;
    let mut second = 0;
    // One more revision than a read follows (CHAIN = 200).
    for n in 1..=(CHAIN as i64 + 1) {
        let mut next = method("timing", &format!("Version {n}."));
        next["revises"] = json!({"activitySeq":previous,"reason":format!("Step {n}.")});
        previous = seq(&comment(&store, "author", &format!("v{n}"), "T-1", next).unwrap());
        if n == 1 {
            second = previous;
        }
    }
    let oldest = record(&store, "T-1", first);
    assert_eq!(oldest["version"], 1);
    assert_eq!(oldest["revisedBy"], second, "the next version is known");
    assert!(oldest["latestActivitySeq"].is_null(), "the newest is unknown, never this one: {}", oldest["latestActivitySeq"]);
    let newest = record(&store, "T-1", previous);
    assert!(newest["version"].is_null(), "its version is not counted");
    assert_eq!(newest["latestActivitySeq"], previous, "it knows it is the newest");
    let db = store.db.read().unwrap();
    let cited = desk_source(&db, "T-1", first).unwrap();
    assert!(cited["latestActivitySeq"].is_null() && cited["version"] == 1, "{cited}");
}

/// A claim with no method and no source: what a finding or a proof can be.
fn finding(id: &str, status: &str, field: &str, title: &str) -> Value {
    json!({"type":"claim","id":id,"title":title,"text":format!("{title}, as its author argues it."),"status":status,
        "field":field,"conditions":["Small inputs only"],"limits":["One machine"]})
}

/// A task whose acceptance is fixed when it is registered.
fn task_with(store: &Store, key: &str, title: &str, acceptance: &str) -> String {
    let created = store.collaboration_call(None, "task_create",
        json!({"requestId":key,"title":title,"materials":{"acceptance":acceptance}})).unwrap();
    created["task"]["id"].as_str().unwrap().to_string()
}

fn version_of_task(store: &Store, task: &str) -> Value {
    store.collaboration_call(None, "task_get", json!({"taskId":task})).unwrap()["task"]["version"].clone()
}

/// A result with one criterion, reported as `status`, citing `records`, at
/// the task's version `at`.
fn result_at(store: &Store, key: &str, task: &str, at: Value, status: &str, records: Value) -> Result<Value> {
    store.collaboration_call(Some("author"), "task_submit_result", json!({"requestId":key,"taskId":task,
        "expectedVersion":at,"summary":format!("Result {key}"),
        "outcome":{"criteria":[{"id":"answer","label":"What the acceptance asks","report":"See the cited claim.",
            "reportedStatus":status,"artifacts":[],"records":records}]}}))
}

fn result(store: &Store, key: &str, task: &str, status: &str, records: Value) -> Result<Value> {
    result_at(store, key, task, version_of_task(store, task), status, records)
}

#[test]
fn the_same_negative_finding_meets_a_question_and_misses_a_threshold_and_neither_status_is_derived() {
    let (_dir, store) = setup();
    let question = task_with(&store, "question", "Does layout B improve the small inputs? (synthetic)",
        "Answer whether layout B improves the small inputs, with the evidence either way");
    let threshold = task_with(&store, "threshold", "Ship a faster layout (synthetic)",
        "Deliver a layout at least 5% faster on the small inputs");
    let title = "Layout B is not faster on the small inputs";
    let mut cited = vec![];
    for task in [&question, &threshold] {
        let answer = comment(&store, "author", &format!("finding-{task}"), task, finding("not-faster", "unsupported", "systems", title)).unwrap();
        cited.push(seq(&answer));
    }
    // The same finding: one task asked a question, the other a threshold.
    let asked_at = version_of_task(&store, &question);
    let met = result_at(&store, "met", &question, asked_at.clone(), "met", json!([{"activitySeq":cited[0]}])).unwrap();
    let missed = result(&store, "missed", &threshold, "not_met", json!([{"activitySeq":cited[1]}])).unwrap();
    for (answer, status, acceptance, seq) in [(&met, "met", "Answer whether", cited[0]), (&missed, "not_met", "Deliver a layout", cited[1])] {
        let stored = &answer["task"]["result"];
        assert!(stored["acceptanceContext"]["text"].as_str().unwrap().starts_with(acceptance), "{stored}");
        let criterion = &stored["outcome"]["criteria"][0];
        assert_eq!(criterion["reportedStatus"], status, "the result author's report stays as given");
        assert_eq!(criterion["records"], json!([{"activitySeq":seq,"version":1,"at":criterion["records"][0]["at"],
            "producer":{"kind":"agent","id":"author","name":"Agent author"},
            "record":{"kind":"research","type":"claim","id":"not-faster","title":title,"status":"unsupported"}}]));
        assert_eq!(answer["task"]["status"], "review", "a negative finding is delivered, not failed or retried");
    }
    // Core derives neither from the other: a supported claim may sit under an
    // unmet criterion too, and the claim itself is unchanged by any result.
    let supported = seq(&comment(&store, "author", "supported", &threshold,
        finding("faster-large", "supported", "systems", "Layout B is faster on the large inputs")).unwrap());
    let both = result(&store, "both", &threshold, "not_met", json!([{"activitySeq":cited[1]},{"activitySeq":supported}])).unwrap();
    assert_eq!(both["task"]["result"]["outcome"]["criteria"][0]["reportedStatus"], "not_met");
    assert_eq!(record(&store, &threshold, cited[1])["research"]["status"], "unsupported");

    // The read says where each cited record stands now, beside the fixed one.
    let read = store.collaboration_call(None, "task_result_get", json!({"taskId":question})).unwrap();
    assert_eq!(read["records"], json!([{"criterionId":"answer","activitySeq":cited[0],"state":"readable",
        "revisedBy":null,"latestActivitySeq":cited[0]}]));
    assert!(read["note"].as_str().unwrap().contains("neither is derived from the other"));
    // A retry is the same result; the same key with other records is refused.
    let again = result_at(&store, "met", &question, asked_at.clone(), "met", json!([{"activitySeq":cited[0]}]));
    assert_eq!(again.unwrap()["task"]["result"]["id"], met["task"]["result"]["id"]);
    let other = result_at(&store, "met", &question, asked_at, "met", json!([]));
    assert!(error(other).starts_with("idempotency_conflict:"));
}

#[test]
fn a_criterion_cites_only_this_tasks_research_records_and_a_refusal_writes_nothing() {
    let (_dir, store) = setup();
    let own = seq(&comment(&store, "author", "own", "T-1", finding("own", "open", "systems", "Undecided so far")).unwrap());
    let elsewhere = seq(&comment(&store, "author", "elsewhere", "T-2", finding("elsewhere", "supported", "systems", "Another task's claim")).unwrap());
    let plain = seq(&store.collaboration_call(Some("author"), "task_comment",
        json!({"requestId":"plain","taskId":"T-1","body":"Just a note"})).unwrap());
    let before = counts(&store);
    for (name, records, expected) in [
        ("another task's record", json!([{"activitySeq":elsewhere}]), "is not a research record of T-1"),
        ("a plain comment", json!([{"activitySeq":plain}]), "is not a research record of T-1"),
        ("no such activity", json!([{"activitySeq":999_999}]), "is not a research record of T-1"),
        ("not a sequence", json!([{"activitySeq":0}]), "positive activity sequence"),
        ("twice", json!([{"activitySeq":own},{"activitySeq":own}]), "cites each research record once"),
        ("a copied identity", json!([{"activitySeq":own,"record":{"status":"supported"}}]), "invalid_input"),
        ("too many", json!(vec![json!({"activitySeq":own}); 11]), "at most 10 research records"),
        ("not a list", json!({"activitySeq":own}), "must be an array"),
    ] {
        let refused = error(result(&store, name, "T-1", "met", records));
        assert!(refused.contains(expected), "{name}: {refused}");
        assert_eq!(counts(&store), before, "{name}: nothing written");
    }
}

#[test]
fn a_result_keeps_the_version_it_cites_and_its_read_says_a_newer_one_exists() {
    let (_dir, store) = setup();
    let first = seq(&comment(&store, "author", "v1", "T-1", finding("faster", "conditional", "systems", "Layout B is faster")).unwrap());
    result(&store, "cites-v1", "T-1", "unknown", json!([{"activitySeq":first}])).unwrap();
    let mut revised = finding("faster", "unsupported", "systems", "Layout B is not faster");
    revised["revises"] = json!({"activitySeq":first,"reason":"Fresh processes erased the gain."});
    let second = seq(&comment(&store, "author", "v2", "T-1", revised).unwrap());
    let read = store.collaboration_call(None, "task_result_get", json!({"taskId":"T-1"})).unwrap();
    let cited = &read["result"]["outcome"]["criteria"][0]["records"][0];
    assert_eq!((cited["activitySeq"].clone(), cited["version"].clone()), (json!(first), json!(1)));
    assert_eq!((cited["record"]["title"].clone(), cited["record"]["status"].clone()),
        (json!("Layout B is faster"), json!("conditional")), "the version cited, as it was");
    assert_eq!(read["records"][0], json!({"criterionId":"answer","activitySeq":first,"state":"readable",
        "revisedBy":second,"latestActivitySeq":second}));
}

#[test]
fn a_theory_claim_is_delivered_without_any_job() {
    let (_dir, store) = setup();
    let task = task_with(&store, "bound", "Does the bound hold for every n? (synthetic)",
        "A proof or a counterexample for the stated bound");
    let mut proof = finding("bound", "supported", "theory", "The bound holds for every n ≥ 1");
    proof["conditions"] = json!(["n ≥ 1", "The cost model of section 2"]);
    proof["limits"] = json!(["Checked by hand; not formalised", "Exhaustive search to n = 12 is no proof for larger n"]);
    let claim = seq(&comment(&store, "author", "proof", &task, proof).unwrap());
    let delivered = result(&store, "proof", &task, "met", json!([{"activitySeq":claim}])).unwrap();
    let criterion = &delivered["task"]["result"]["outcome"]["criteria"][0];
    assert_eq!(criterion["artifacts"], json!([]));
    assert_eq!(criterion["records"][0]["record"]["status"], "supported");
    let key = task_key(&store.db.read().unwrap(), &task).unwrap().0;
    let jobs: i64 = store.db.read().unwrap()
        .query_row("SELECT COUNT(*) FROM local_jobs WHERE task_id=?1", params![key], |r| r.get(0)).unwrap();
    assert_eq!(jobs, 0, "no Job, no seed, and nothing asked for one");
}

#[test]
fn a_field_can_differ_among_the_entries_that_give_it_and_be_missing_on_others() {
    let (_dir, store) = setup();
    let m1 = seq(&comment(&store, "author", "m1", "T-1", method("timing", "Ten iterations in one process.")).unwrap());
    let mut revised = method("timing", "Ten fresh processes.");
    revised["revises"] = json!({"activitySeq":m1,"reason":"Iterations in one process are not independent runs."});
    let m2 = seq(&comment(&store, "author", "m2", "T-1", revised).unwrap());
    // Units ms, s and none; methods by their fixed activities; a level given
    // by two of three; one definition throughout. Partial facts stay as given.
    let entries = json!([
        {"id":"a","label":"A","status":"included","unit":"ms","definition":"median of runs","level":"process",
            "method":{"activitySeq":m1},"value":{"value":12.0,"low":10.5}},
        {"id":"b","label":"B","status":"included","unit":"s","definition":"median of runs",
            "method":{"activitySeq":m2},"n":10},
        {"id":"c","label":"C","status":"included","definition":"median of runs","level":"process",
            "method":{"activitySeq":m1},"value":{"value":11.0,"high":12.5}},
        {"id":"d","label":"D","status":"missing","reason":"The large set was not exported.","unit":"ms"},
    ]);
    let answer = comment(&store, "author", "mixed", "T-1", comparison(m1, m2, entries)).unwrap();
    let stored = &answer["activity"]["research"];
    let summary = &stored["comparability"];
    assert_eq!(summary["differs"], json!(["unit", "method"]), "known values that differ are said: {summary}");
    assert_eq!(summary["unknown"], json!(["unit", "level"]), "and so is what some entries leave out: {summary}");
    assert_eq!(summary["shared"], json!({"definition":"median of runs"}), "a field missing anywhere is never shared");
    assert_eq!(summary["aligned"], false);
    assert_eq!(summary["counts"], json!({"included":3,"excluded":0,"missing":1,"not_done":0}));
    // The entries keep exactly what their author gave, nothing made up.
    assert_eq!(stored["entries"][0]["value"], json!({"value":12.0,"low":10.5}));
    assert_eq!(stored["entries"][1].get("value"), None);
    assert_eq!((stored["entries"][1]["n"].clone(), stored["entries"][1].get("level")), (json!(10), None));
    assert_eq!(stored["entries"][2]["value"], json!({"value":11.0,"high":12.5}));
    assert_eq!((stored["entries"][3]["unit"].clone(), stored["entries"][3].get("value")), (json!("ms"), None));
    assert_eq!(stored["entries"][1]["method"]["activitySeq"], m2, "each entry keeps the method version it names");
    // Every entry giving the same value for a field is shared, and with one
    // missing field the comparison says that alone.
    let same = json!([entry("x", "included", m2, "%", "process"), {"id":"y","label":"Y","status":"included",
        "method":{"activitySeq":m2},"unit":"%","definition":"median of runs","n":10}]);
    let mut record = comparison(m2, m2, same);
    record["id"] = json!("same");
    let summary = comment(&store, "author", "same", "T-1", record).unwrap()["activity"]["research"]["comparability"].clone();
    assert_eq!((summary["differs"].clone(), summary["unknown"].clone()), (json!([]), json!(["level"])));
    assert_eq!(summary["shared"], json!({"unit":"%","definition":"median of runs","method":m2}));
}
