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
