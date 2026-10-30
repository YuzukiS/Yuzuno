use super::*;
use crate::model::AgentDetail;

const ATTEMPT: &str = "11111111-1111-4111-8111-111111111111";
const OTHER_ATTEMPT: &str = "22222222-2222-4222-8222-222222222222";

fn setup() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    for id in ["author", "next"] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),
            "cwd":"/synthetic/work","model":"test","color":"sage","threadId":format!("session-{id}"),
            "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        store.insert(&agent).unwrap();
    }
    store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"create","title":"Evidence outcome",
        "materials":{"acceptance":"An output passes its stated checks"}}),
        )
        .unwrap();
    job(&store, "T-1", "job-1");
    (dir, store)
}

fn job(store: &Store, task: &str, id: &str) {
    let task = task_key(&store.db.read().unwrap(), task).unwrap().0;
    let data = json!({"id":id,"taskId":task,"agentId":"author","attempt":ATTEMPT,"status":"succeeded",
        "cwd":"/synthetic/does-not-exist","machine":{"name":"Synthetic host"},"finishedAt":"2026-10-01T00:00:00Z",
        "env":{"PRIVATE":"must not leave the Job"},"argv":["private command"],
        "result":{"attempt":ATTEMPT,"artifacts":[{"path":"out/result.json","sha256":"a".repeat(64),
            "ok":true,"bytes":12,"absolutePath":"/synthetic/does-not-exist/out/result.json"}]}});
    store.db.write().unwrap().execute("INSERT INTO local_jobs(id,task_id,agent_id,status,data) VALUES(?1,?2,'author','succeeded',?3)",
        params![id,task,data.to_string()]).unwrap();
}

fn submission(key: &str, version: i64) -> Value {
    json!({"requestId":key,"taskId":"T-1","expectedVersion":version,"summary":format!("Result {key}"),
        "outcome":{"criteria":[{"id":"shape","label":"Output format","report":"The declared JSON check passed",
            "reportedStatus":"met","artifacts":[{"jobId":"job-1","attempt":ATTEMPT,"path":"out/result.json","sha256":"a".repeat(64)}]}],
            "remaining":"Independent assessment remains","nextAgentId":"next","nextStep":"Assess the criterion"}})
}

fn read(store: &Store, input: Value) -> Value {
    store
        .collaboration_call(None, "task_result_get", input)
        .unwrap()
}

fn counts(store: &Store) -> (i64, i64, i64, i64) {
    store.db.read().unwrap().query_row("SELECT (SELECT version FROM collaboration_tasks WHERE seq=1),
        (SELECT COUNT(*) FROM collaboration_task_activity),(SELECT COUNT(*) FROM collaboration_requests),
        (SELECT COUNT(*) FROM collaboration_messages)", [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).unwrap()
}

#[test]
fn a_result_keeps_its_report_identity_context_and_suggested_owner_across_updates_and_retries() {
    let (_dir, store) = setup();
    let input = submission("first", 1);
    let first = store
        .collaboration_call(Some("author"), "task_submit_result", input.clone())
        .unwrap();
    let original = &first["task"]["result"];
    assert_eq!(original["taskVersion"], 2);
    assert_eq!(
        original["outcome"]["nextAgent"],
        json!({"kind":"agent","id":"next","name":"Agent next"})
    );
    assert_eq!(
        original["acceptanceContext"]["text"],
        "An output passes its stated checks"
    );
    assert_eq!(original["acceptanceContext"]["source"], "registration");
    assert!(
        first["task"]["assigneeAgentId"].is_null(),
        "a suggestion never assigns"
    );
    assert_eq!(counts(&store).3, 0, "a suggestion never sends mail");
    let old_id = original["id"].clone();
    store
        .update("next", "agent/renamed", &json!({}), |detail| {
            detail.agent.name = "Renamed Agent".into();
        })
        .unwrap();
    let second = store
        .collaboration_call(
            Some("author"),
            "task_submit_result",
            submission("second", 2),
        )
        .unwrap();
    store
        .collaboration_call(
            None,
            "task_update",
            json!({"requestId":"later","taskId":"T-1","expectedVersion":3,
        "patch":{"status":"doing","materials":{"acceptance":"A changed requirement"}}}),
        )
        .unwrap();
    let later = read(&store, json!({"taskId":"T-1","resultId":old_id}));
    assert_eq!(later["result"], *original);
    assert_eq!(
        second["task"]["result"]["outcome"]["nextAgent"]["name"],
        "Renamed Agent"
    );
    assert_eq!(later["taskVersion"], 4);
    assert_eq!(later["currentResultId"], second["task"]["result"]["id"]);
    assert_eq!(
        later["history"][0]["resultId"],
        second["task"]["result"]["id"]
    );
    assert_eq!(later["history"][1]["taskVersion"], 2);
    assert_eq!(
        store
            .collaboration_call(Some("author"), "task_submit_result", input.clone())
            .unwrap(),
        first
    );
    let before = counts(&store);
    let mut changed = input;
    changed["outcome"]["criteria"][0]["report"] = json!("Changed report");
    assert!(
        store
            .collaboration_call(Some("author"), "task_submit_result", changed)
            .unwrap_err()
            .to_string()
            .starts_with("idempotency_conflict:")
    );
    assert_eq!(counts(&store), before);
    assert!(
        later["note"]
            .as_str()
            .unwrap()
            .contains("not criterion satisfaction")
    );
}

#[test]
fn mismatched_artifacts_and_forged_decisions_reject_the_entire_submission() {
    let (_dir, store) = setup();
    store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"other","title":"Other task"}),
        )
        .unwrap();
    job(&store, "T-2", "other-job");
    let before = counts(&store);
    for (key, value) in [
        ("jobId", json!("other-job")),
        ("jobId", json!("missing-job")),
        ("attempt", json!(OTHER_ATTEMPT)),
        ("attempt", json!(1)),
        ("path", json!("different.json")),
        ("path", json!("../outside")),
        ("path", json!("C:\\outside")),
        ("sha256", json!("b".repeat(64))),
    ] {
        let mut input = submission("bad-reference", 1);
        input["outcome"]["criteria"][0]["artifacts"][0][key] = value;
        assert!(
            store
                .collaboration_call(Some("author"), "task_submit_result", input)
                .is_err(),
            "{key}"
        );
        assert_eq!(counts(&store), before, "no partial result, mail or receipt");
    }
    for key in ["verifiedBy", "acceptedBy", "nextAgent"] {
        let mut input = submission("forged", 1);
        input["outcome"][key] = json!({"kind":"user","name":"You"});
        assert!(
            store
                .collaboration_call(Some("author"), "task_submit_result", input)
                .is_err()
        );
        assert_eq!(counts(&store), before);
    }
    for patch in [
        "'$.result.artifacts[0].ok',json('false')",
        "'$.result.artifacts[0].sha256',NULL",
        "'$.result.attempt','22222222-2222-4222-8222-222222222222'",
    ] {
        store.db.write().unwrap().execute("UPDATE local_jobs SET data=json_set(data,'$.result.artifacts[0].ok',json('true'),'$.result.artifacts[0].sha256',?1,'$.result.attempt',?2) WHERE id='job-1'", params!["a".repeat(64),ATTEMPT]).unwrap();
        store
            .db
            .write()
            .unwrap()
            .execute(
                &format!("UPDATE local_jobs SET data=json_set(data,{patch}) WHERE id='job-1'"),
                [],
            )
            .unwrap();
        assert!(
            store
                .collaboration_call(
                    Some("author"),
                    "task_submit_result",
                    submission("bad-check", 1)
                )
                .is_err()
        );
        assert_eq!(counts(&store), before);
    }
    assert!(read(&store, json!({"taskId":"T-1"}))["result"].is_null());
}

#[test]
fn an_assignment_result_snapshots_original_acceptance_and_preserves_dispatch_permissions() {
    let (_dir, store) = setup();
    let dispatched = store.collaboration_call(None, "task_dispatch", json!({"requestId":"dispatch","taskId":"T-1",
        "expectedVersion":1,"toAgentId":"author","materials":{"acceptance":"The fixed assignment criterion"}})).unwrap();
    store
        .collaboration_call(
            None,
            "task_update",
            json!({"requestId":"new-material","taskId":"T-1","expectedVersion":2,
        "patch":{"materials":{"acceptance":"Changed after assignment"}}}),
        )
        .unwrap();
    let mut input = submission("assigned", 3);
    let before = counts(&store);
    assert!(
        store
            .collaboration_call(Some("author"), "task_submit_result", input.clone())
            .unwrap_err()
            .to_string()
            .starts_with("dispatch_id_required:")
    );
    input["dispatchId"] = dispatched["task"]["dispatch"]["id"].clone();
    assert!(
        store
            .collaboration_call(Some("next"), "task_submit_result", input.clone())
            .unwrap_err()
            .to_string()
            .starts_with("dispatch_actor_mismatch:")
    );
    assert_eq!(counts(&store), before);
    let result = store
        .collaboration_call(Some("author"), "task_submit_result", input)
        .unwrap()["task"]["result"]
        .clone();
    assert_eq!(
        result["acceptanceContext"]["text"],
        "The fixed assignment criterion"
    );
    assert_eq!(result["acceptanceContext"]["source"], "dispatch");
    assert_eq!(
        result["acceptanceContext"]["dispatchId"],
        result["dispatchId"]
    );
    assert_eq!(read(&store, json!({"taskId":"T-1"}))["result"], result);
    let task = store
        .collaboration_call(None, "task_get", json!({"taskId":"T-1"}))
        .unwrap();
    assert_eq!(task["task"]["assigneeAgentId"], "author");
}

#[test]
fn recorded_resolution_never_claims_current_files_or_exposes_job_commands_and_rechecks_records() {
    let (_dir, store) = setup();
    let result = store
        .collaboration_call(None, "task_submit_result", submission("r", 1))
        .unwrap()["task"]["result"]
        .clone();
    let page = read(&store, json!({"taskId":"T-1"}));
    let artifact = &page["artifacts"][0];
    assert_eq!(
        artifact["state"], "recorded_match",
        "the synthetic cwd does not exist; this is a retained-record read"
    );
    assert_eq!(artifact["bytes"], 12);
    assert_eq!(artifact["index"], 0);
    assert_eq!(artifact["downloadable"], true);
    assert!(
        artifact["checkedAt"].is_null(),
        "finishedAt is not a recorded check timestamp"
    );
    assert_eq!(artifact["finishedAt"], "2026-10-01T00:00:00Z");
    assert!(!page.to_string().contains("private command"));
    assert!(!page.to_string().contains("PRIVATE"));
    assert!(!page.to_string().contains("absolutePath"));
    store.db.write().unwrap().execute("UPDATE local_jobs SET data=json_set(data,'$.executor',json('{\"kind\":\"local\"}')) WHERE id='job-1'", []).unwrap();
    assert_eq!(
        read(&store, json!({"taskId":"T-1"}))["artifacts"][0]["downloadable"],
        true
    );
    store.db.write().unwrap().execute("UPDATE local_jobs SET data=json_set(data,'$.executor',json('{\"kind\":\"ssh\",\"machineName\":\"Remote machine\"}')) WHERE id='job-1'", []).unwrap();
    let remote = read(&store, json!({"taskId":"T-1"}));
    assert_eq!(remote["artifacts"][0]["state"], "recorded_match");
    assert_eq!(remote["artifacts"][0]["downloadable"], false);
    store.db.write().unwrap().execute("UPDATE local_jobs SET data=json_set(data,'$.result.artifacts[0].sha256',?1) WHERE id='job-1'", ["b".repeat(64)]).unwrap();
    assert_eq!(
        read(&store, json!({"taskId":"T-1"}))["artifacts"][0]["state"],
        "artifact_mismatch"
    );
    store.db.write().unwrap().execute("UPDATE local_jobs SET data=json_set(data,'$.result.artifacts',json('[]')) WHERE id='job-1'", []).unwrap();
    assert_eq!(
        read(&store, json!({"taskId":"T-1"}))["artifacts"][0]["state"],
        "artifact_missing"
    );
    store
        .db
        .write()
        .unwrap()
        .execute(
            "UPDATE local_jobs SET data=json_set(data,'$.attempt',?1) WHERE id='job-1'",
            [OTHER_ATTEMPT],
        )
        .unwrap();
    assert_eq!(
        read(&store, json!({"taskId":"T-1"}))["artifacts"][0]["state"],
        "attempt_mismatch"
    );
    store
        .db
        .write()
        .unwrap()
        .execute("DELETE FROM local_jobs WHERE id='job-1'", [])
        .unwrap();
    let missing = read(&store, json!({"taskId":"T-1"}));
    assert_eq!(missing["artifacts"][0]["state"], "job_missing");
    assert_eq!(
        missing["result"], result,
        "resolution never rewrites the author's saved reference"
    );
}

#[test]
fn result_history_pages_by_stable_sequence_and_retains_legacy_results_without_ids() {
    let (_dir, store) = setup();
    let id = task_key(&store.db.read().unwrap(), "T-1").unwrap().0;
    let legacy = json!({"summary":"Legacy report","links":[],"reportedAt":"then"});
    {
        let db = store.db.write().unwrap();
        db.execute(
            "UPDATE collaboration_tasks SET data=json_set(data,'$.result',json(?1)) WHERE id=?2",
            params![legacy.to_string(), id],
        )
        .unwrap();
        activity(
            &db,
            &id,
            "result",
            &TaskActor {
                kind: "user".into(),
                id: "user".into(),
                name: "You".into(),
            },
            &Value::Null,
            json!({"result":legacy}),
        )
        .unwrap();
    }
    let first = read(&store, json!({"taskId":"T-1"}));
    assert_eq!(first["result"], legacy);
    assert!(first["currentResultId"].is_null());
    assert!(first["history"][0]["resultId"].is_null());
    for version in 1..=12 {
        store
            .collaboration_call(
                None,
                "task_submit_result",
                submission(&format!("r{version}"), version),
            )
            .unwrap();
    }
    let page = read(&store, json!({"taskId":"T-1","limit":10}));
    assert_eq!(page["history"].as_array().unwrap().len(), 10);
    assert_eq!(page["hasMore"], true);
    store
        .collaboration_call(None, "task_submit_result", submission("new", 13))
        .unwrap();
    let rest = read(
        &store,
        json!({"taskId":"T-1","before":page["nextBefore"],"limit":10}),
    );
    assert_eq!(rest["history"].as_array().unwrap().len(), 3);
    assert_eq!(rest["hasMore"], false);
    assert!(rest["history"][2]["resultId"].is_null());
    assert_eq!(rest["history"][2]["summary"], "Legacy report");
    assert_eq!(
        rest["result"]["summary"], "Result new",
        "selection is independent of the history cursor"
    );
    store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"other","title":"Other"}),
        )
        .unwrap();
    assert!(
        store
            .collaboration_call(
                None,
                "task_result_get",
                json!({"taskId":"T-2","resultId":page["currentResultId"]})
            )
            .is_err()
    );
    for input in [
        json!({"taskId":"T-1","limit":21}),
        json!({"taskId":"T-1","before":0}),
        json!({"taskId":"T-1","resultId":null}),
        json!({"taskId":"T-1","accepted":true}),
    ] {
        assert!(
            store
                .collaboration_call(None, "task_result_get", input)
                .is_err()
        );
    }
}

#[test]
fn outcome_bounds_and_catalog_keep_the_contract_optional_and_author_scoped() {
    let (_dir, store) = setup();
    let before = counts(&store);
    for (name, outcome) in [
        (
            "duplicate",
            json!({"criteria":[submission("x",1)["outcome"]["criteria"][0],submission("x",1)["outcome"]["criteria"][0]]}),
        ),
        (
            "too-many",
            json!({"criteria":(0..21).map(|i| json!({"id":i.to_string(),"label":"c","report":"unknown","reportedStatus":"unknown","artifacts":[]})).collect::<Vec<_>>()}),
        ),
        (
            "bytes",
            json!({"criteria":[],"remaining":"x".repeat(MAX_BYTES)}),
        ),
        (
            "missing-owner",
            json!({"criteria":[],"nextAgentId":"absent"}),
        ),
        (
            "invented-status",
            json!({"criteria":[{"id":"c","label":"c","report":"r","reportedStatus":"accepted","artifacts":[]}]}),
        ),
        (
            "too-many-refs",
            json!({"criteria":[{"id":"c","label":"c","report":"r","reportedStatus":"unknown",
            "artifacts":vec![submission("x",1)["outcome"]["criteria"][0]["artifacts"][0].clone();11]}]}),
        ),
        (
            "total-refs",
            json!({"criteria":(0..5).map(|i| json!({"id":i.to_string(),"label":"c","report":"r","reportedStatus":"unknown",
            "artifacts":vec![submission("x",1)["outcome"]["criteria"][0]["artifacts"][0].clone();9]})).collect::<Vec<_>>()}),
        ),
    ] {
        let mut input = submission(name, 1);
        input["outcome"] = outcome;
        assert!(
            store
                .collaboration_call(None, "task_submit_result", input)
                .is_err(),
            "{name}"
        );
        assert_eq!(counts(&store), before);
    }
    let legacy_input =
        json!({"requestId":"plain","taskId":"T-1","expectedVersion":1,"summary":"Plain report"});
    let plain = store
        .collaboration_call(None, "task_submit_result", legacy_input)
        .unwrap();
    assert!(plain["task"]["result"].get("outcome").is_none());
    store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"no-context","title":"No saved acceptance"}),
        )
        .unwrap();
    let unregistered = store.collaboration_call(None, "task_submit_result", json!({"requestId":"no-context-result","taskId":"T-2",
        "expectedVersion":1,"summary":"A report without saved acceptance","outcome":{"criteria":[],"remaining":"","nextStep":""}})).unwrap();
    assert_eq!(
        unregistered["task"]["result"]["acceptanceContext"]["source"],
        "not_recorded"
    );
    assert!(unregistered["task"]["result"]["acceptanceContext"]["text"].is_null());
    for definition in super::super::tool_definitions() {
        if definition["name"] == "task_submit_result" {
            assert_eq!(definition["inputSchema"]["properties"]["outcome"], schema());
            assert!(
                !definition["inputSchema"]["required"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("outcome"))
            );
        }
        if definition["name"] == "task_result_get" {
            let _: rmcp::model::Tool = serde_json::from_value(definition.clone()).unwrap();
            assert_eq!(definition["inputSchema"]["required"], json!(["taskId"]));
            assert!(definition.get("outputSchema").is_none());
        }
    }
}
