use super::*;
use crate::{github::client::Repository, model::AgentDetail};
use std::collections::BTreeMap;

fn fixture() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    for id in ["lead", "dev"] {
        let agent: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":id,
            "cwd":"/private/not-a-worktree","model":"test","color":"sage","threadId":format!("session-{id}"),
            "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        store.insert(&agent).unwrap();
    }
    store.collaboration_call(None, "task_create", json!({"requestId":"create","title":"修复文件行号定位","description":"Support path:42 and path#L42; keep drafts."})).unwrap();
    (dir, store)
}
fn task(store: &Store) -> Value {
    store
        .collaboration_call(None, "task_get", json!({"taskId":"T-1"}))
        .unwrap()
}
fn edit(store: &Store, request: &str, patch: Value) {
    store.collaboration_call(None, "task_update", json!({"requestId":request,"taskId":"T-1","expectedVersion":task(store)["task"]["version"],"patch":patch})).unwrap();
}
fn send(store: &Store, request: &str, extras: Value) -> Value {
    let mut input = json!({"requestId":request,"taskId":"T-1","expectedVersion":task(store)["task"]["version"],"toAgentId":"dev"});
    input
        .as_object_mut()
        .unwrap()
        .extend(extras.as_object().unwrap().clone());
    store
        .collaboration_call(Some("lead"), "task_dispatch", input)
        .unwrap()
}
fn frozen(store: &Store, message: &Value) -> Value {
    store
        .collaboration_call(
            Some("dev"),
            "task_get",
            json!({"taskId":"T-1","dispatchId":message["dispatchId"]}),
        )
        .unwrap()["dispatchMaterials"]
        .clone()
}
fn repos(store: &Store) -> String {
    let project = store
        .create_project(
            "Two repos",
            BTreeMap::from([("local".into(), "/private/project-default".into())]),
        )
        .unwrap();
    for id in [1, 2] {
        store
            .github_link_repo(
                &project.id,
                &Repository {
                    id,
                    full_name: format!("owner/repo{id}"),
                },
            )
            .unwrap();
    }
    edit(store, "project", json!({"projectId":project.id}));
    project.id
}

#[test]
fn empty_body_retains_goal_and_never_infers_missing_work_details() {
    let (_dir, store) = fixture();
    let sent = send(&store, "send", json!({"body":""}));
    let message = &sent["message"];
    let body = message["body"].as_str().unwrap();
    assert!(body.contains("修复文件行号定位") && body.contains("path#L42"));
    assert!(
        body.contains("Acceptance: Not specified")
            && body.contains("Worktree (information, not permission): Not specified")
    );
    assert!(!body.contains("/private/"));
    assert_eq!(message["materialsRef"]["dispatchId"], message["dispatchId"]);
    assert!(sent["activity"].get("materials").is_none());
    let snapshot = frozen(&store, message);
    assert_eq!(snapshot["task"]["version"], 2);
    assert_eq!(snapshot["returnTo"]["id"], "lead");
    assert_eq!(snapshot["source"]["sessionId"], "session-lead");
    assert!(snapshot["effective"]["worktree"].is_null());
    assert!(store.detail("dev").unwrap().turns.is_empty());
}

#[test]
fn registered_materials_and_overrides_do_not_replace_the_goal() {
    let (_dir, store) = fixture();
    edit(
        &store,
        "register",
        json!({"materials":{"acceptance":"Both formats work; out-of-range is explicit.","worktree":"/explicit/tree","returnRequirements":"Return validation and a PR link."}}),
    );
    let sent = send(
        &store,
        "send",
        json!({"body":"Preserve the existing preview.","materials":{"worktree":"/explicit/override"}}),
    );
    let body = sent["message"]["body"].as_str().unwrap();
    for expected in [
        "path#L42",
        "Both formats",
        "Preserve the existing preview",
        "/explicit/override",
        "Return validation",
    ] {
        assert!(body.contains(expected));
    }
    let snapshot = frozen(&store, &sent["message"]);
    assert_eq!(snapshot["effective"]["worktree"], "/explicit/override");
    assert_eq!(snapshot["registeredSource"]["taskVersion"], 2);
    assert_eq!(snapshot["overriddenFields"], json!(["worktree"]));
    assert_eq!(
        task(&store)["task"]["materials"]["worktree"],
        "/explicit/tree"
    );
    let cleared = send(&store, "clear-once", json!({"materials":null}));
    assert_eq!(frozen(&store, &cleared["message"])["effective"], json!({}));
    assert_eq!(
        task(&store)["task"]["materials"]["worktree"],
        "/explicit/tree"
    );
}

#[test]
fn retries_and_old_dispatch_reads_stay_fixed_after_task_and_github_changes_and_restart() {
    let (dir, store) = fixture();
    repos(&store);
    let repo = Repository {
        id: 1,
        full_name: "owner/repo1".into(),
    };
    let before = json!({"baseSha":"a".repeat(40),"headSha":"b".repeat(40),"observedAt":"2020-01-01T00:00:00Z","state":"open"});
    store
        .github_link_object("T-1", &repo, "pull", 7, before)
        .unwrap();
    {
        let db = store.db.write().unwrap();
        db.execute(
            "UPDATE github_objects SET data=json_set(data,'$.syncedAt','2020-01-01T00:00:00Z')",
            [],
        )
        .unwrap();
    }
    let input = json!({"requestId":"fixed","taskId":"T-1","expectedVersion":2,"toAgentId":"dev"});
    let sent = store
        .collaboration_call(Some("lead"), "task_dispatch", input.clone())
        .unwrap();
    let original = frozen(&store, &sent["message"]);
    assert_eq!(original["github"][0]["headSha"], "b".repeat(40));
    assert_eq!(original["github"][0]["stale"], true);
    assert_eq!(original["repositories"].as_array().unwrap().len(), 2);
    assert!(original["effective"]["repositoryId"].is_null());
    assert!(!original.to_string().contains("/private/"));
    edit(
        &store,
        "changed",
        json!({"description":"New goal version", "materials":{"worktree":"/new/tree"}}),
    );
    {
        let db = store.db.write().unwrap();
        db.execute(
            "UPDATE github_objects SET data=json_set(data,'$.snapshot.headSha',?1)",
            ["c".repeat(40)],
        )
        .unwrap();
    }
    send(&store, "redispatch", json!({}));
    drop(store);
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    assert_eq!(
        store
            .collaboration_call(Some("lead"), "task_dispatch", input)
            .unwrap(),
        sent
    );
    assert_eq!(frozen(&store, &sent["message"]), original);
    assert_eq!(task(&store)["task"]["description"], "New goal version");
    let inbox = store
        .collaboration_call(Some("dev"), "peer_read", json!({"priority":"normal"}))
        .unwrap();
    assert_eq!(inbox["messages"].as_array().unwrap().len(), 2);
}

#[test]
fn full_unicode_fields_are_referenced_and_normal_activity_pages_are_small() {
    let (_dir, store) = fixture();
    let description = "中文描述".repeat(2_000);
    let supplement = "补充要求".repeat(1_200);
    let acceptance = "验收条件".repeat(1_200);
    edit(
        &store,
        "long",
        json!({"description":description,"materials":{"acceptance":acceptance}}),
    );
    let sent = send(&store, "long-dispatch", json!({"body":supplement}));
    let body = sent["message"]["body"].as_str().unwrap();
    assert!(body.len() < 16_384);
    for field in ["task.description", "effective.acceptance", "supplement"] {
        assert!(body.contains(field));
    }
    let snapshot = frozen(&store, &sent["message"]);
    assert_eq!(snapshot["task"]["description"], description);
    assert_eq!(snapshot["effective"]["acceptance"], acceptance);
    assert_eq!(snapshot["supplement"], supplement);
    for event in task(&store)["activities"].as_array().unwrap() {
        if event["kind"] == "dispatched" {
            assert!(event.get("materials").is_none());
            assert!(event["materialsRef"].is_object());
        }
    }
}

#[test]
fn fixed_reads_are_indexed_scoped_and_do_not_expand_current_task_history() {
    let (_dir, store) = fixture();
    let sent = send(&store, "send", json!({}));
    let original = frozen(&store, &sent["message"]);
    edit(
        &store,
        "later",
        json!({"description":"Later task definition"}),
    );
    for i in 0..100 {
        store.collaboration_call(Some("dev"), "task_comment", json!({
            "requestId":format!("history-{i}"),"taskId":"T-1","body":"Later execution evidence"
        })).unwrap();
    }
    let response = store
        .collaboration_call(
            None,
            "task_get",
            json!({
                "taskId":"T-1","dispatchId":sent["message"]["dispatchId"]
            }),
        )
        .unwrap();
    assert_eq!(
        response,
        json!({"dispatchMaterials":original,"latestTask":{"taskId":"T-1"}})
    );
    store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"other","title":"Other task"}),
        )
        .unwrap();
    assert!(
        store
            .collaboration_call(
                None,
                "task_get",
                json!({
                    "taskId":"T-2","dispatchId":sent["message"]["dispatchId"]
                })
            )
            .unwrap_err()
            .to_string()
            .contains("dispatch_materials_not_found")
    );
    let db = store.db.read().unwrap();
    let plan: String = db.query_row("EXPLAIN QUERY PLAN SELECT json_extract(data,'$.materials') FROM collaboration_task_activity
        WHERE task_id=?1 AND json_extract(data,'$.kind')='dispatched' AND json_extract(data,'$.dispatch.id')=?2
        AND json_type(data,'$.materials')='object' ORDER BY seq DESC LIMIT 1",
        params!["unused-task", "unused-dispatch"], |r| r.get(3)).unwrap();
    assert!(
        plan.contains("SEARCH") && plan.contains("collaboration_activity_materials"),
        "{plan}"
    );
}

#[test]
fn final_message_budget_includes_all_inline_fields_references_and_recipient() {
    let (_dir, store) = fixture();
    let sent = send(&store, "send", json!({}));
    let mut snapshot = frozen(&store, &sent["message"]);
    snapshot["task"]["title"] = json!("字".repeat(100));
    for (key, limit) in [
        ("acceptance", 1500),
        ("baseline", 500),
        ("worktree", 500),
        ("returnRequirements", 1000),
    ] {
        snapshot["effective"][key] = json!("x".repeat(limit));
    }
    snapshot["effective"]["repositoryId"] = json!(i64::MAX);
    snapshot["effective"]["baseSha"] = json!("a".repeat(64));
    snapshot["effective"]["headSha"] = json!("b".repeat(64));
    snapshot["task"]["description"] = json!("x".repeat(2000));
    snapshot["supplement"] = json!("x".repeat(2000));
    for key in ["repositories", "github"] {
        let mut entries = json!([{"id":1,"url":"https://example.test/","fullName":""}]);
        entries[0]["fullName"] = json!("r".repeat(1500 - entries.to_string().len()));
        assert_eq!(entries.to_string().len(), 1500);
        snapshot[key] = entries;
    }
    let mut references = json!([{"kind":"evidence","label":"Evidence","url":""}]);
    references[0]["url"] = json!(format!(
        "https://example.test/{}",
        "r".repeat(1500 - references.to_string().len() - "https://example.test/".len())
    ));
    snapshot["effective"]["references"] = references;
    for name in ["\u{1}".repeat(80), "Large legacy name".repeat(500)] {
        snapshot["returnTo"]["name"] = json!(name);
        let rendered = body(&snapshot);
        assert!(rendered.len() <= 16_384, "{} bytes", rendered.len());
        assert!(rendered.contains("Work on task T-1:"));
        assert!(rendered.contains(snapshot["dispatchId"].as_str().unwrap()));
        assert!(rendered.contains("task_get(taskId="));
        assert!(rendered.contains("task_submit_result with the original dispatchId"));
    }
}

#[test]
fn explicit_references_are_validated_and_can_be_read_without_guessing() {
    let (_dir, store) = fixture();
    let seq = task(&store)["activities"][0]["seq"].clone();
    edit(
        &store,
        "references",
        json!({"materials":{"references":[
        {"kind":"decision","label":"Recorded scope","taskId":"T-1","activitySeq":seq},
        {"kind":"acceptance","label":"Spec","url":"https://example.test/spec#L42"}]}}),
    );
    let sent = send(&store, "send", json!({}));
    let snapshot = frozen(&store, &sent["message"]);
    let reference = &snapshot["effective"]["references"][0];
    let read = store
        .collaboration_call(
            Some("dev"),
            "task_get",
            json!({"taskId":reference["taskId"],"afterSeq":seq.as_i64().unwrap()-1,"limit":1}),
        )
        .unwrap();
    assert_eq!(read["activities"][0]["seq"], seq);
    assert_eq!(
        snapshot["effective"]["references"][1]["url"],
        "https://example.test/spec#L42"
    );
    assert!(
        store
            .collaboration_call(
                None,
                "task_get",
                json!({"taskId":"T-1","dispatchId":"wrong"})
            )
            .unwrap_err()
            .to_string()
            .contains("dispatch_materials_not_found")
    );
}

#[test]
fn a_reference_error_says_which_fields_go_together() {
    let (_dir, store) = fixture();
    let refused = |reference: Value| {
        let before = task(&store);
        store.collaboration_call(None, "task_update", json!({"requestId":format!("ref-{reference}"),"taskId":"T-1",
            "expectedVersion":before["task"]["version"],"patch":{"materials":{"references":[reference]}}})).unwrap_err().to_string()
    };
    let missing_seq = refused(json!({"kind":"evidence","label":"Scope","taskId":"T-1"}));
    assert!(missing_seq.contains("needs activitySeq") && missing_seq.contains("task_get with view \"activity\": activities[].seq") && missing_seq.contains("url"), "{missing_seq}");
    let neither = refused(json!({"kind":"evidence","label":"Scope"}));
    assert!(neither.contains("needs url, or taskId with activitySeq"), "{neither}");
    let unknown_seq = refused(json!({"kind":"evidence","label":"Scope","taskId":"T-1","activitySeq":9999}));
    assert!(unknown_seq.contains("T-1 has no activity with seq 9999"), "{unknown_seq}");
    let items = &schema()["properties"]["references"]["items"]["properties"];
    assert!(items["taskId"]["description"].as_str().unwrap().contains("Needs activitySeq"));
    assert!(items["activitySeq"]["description"].as_str().unwrap().contains("Needs taskId"));
}

#[test]
fn invalid_or_oversized_materials_roll_back_the_entire_dispatch() {
    let (_dir, store) = fixture();
    repos(&store);
    for (index, materials) in [json!({"baseSha":"a".repeat(40)}), json!({"repositoryId":99}),
        json!({"acceptance":"x".repeat(16_385)}),json!({"worktree":"x".repeat(4097)}),
        json!({"references":[{"kind":"evidence","label":"bad","url":"file:///private/key"}]}),
        json!({"references":[{"kind":"decision","label":"missing","taskId":"T-1","activitySeq":9999}]}),
        json!({"permissions":"unrestricted"})].into_iter().enumerate() {
        let before=task(&store);
        assert!(store.collaboration_call(Some("lead"),"task_dispatch",json!({"requestId":format!("invalid-{index}"),"taskId":"T-1","expectedVersion":before["task"]["version"],"toAgentId":"dev","materials":materials})).is_err());
        assert_eq!(task(&store),before);
    }
    assert!(
        store
            .collaboration_call(None, "peer_read", json!({}))
            .unwrap()["messages"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let sent = send(
        &store,
        "selected",
        json!({"materials":{"repositoryId":2,"baseSha":"a".repeat(40),"worktree":"/explicit"}}),
    );
    assert_eq!(
        frozen(&store, &sent["message"])["effective"]["repositoryId"],
        2
    );
}

#[test]
fn registrations_survive_old_task_json_rewrites_and_explicit_clear() {
    let (dir, store) = fixture();
    edit(
        &store,
        "register",
        json!({"materials":{"acceptance":"Must survive older clients"}}),
    );
    edit(&store, "legacy-style", json!({"progress":"Progress only"}));
    // Simulate a client writing the old typed shape: materials live in activity.
    {
        let db = store.db.write().unwrap();
        db.execute(
            "UPDATE collaboration_tasks SET data=json_remove(data,'$.materials')",
            [],
        )
        .unwrap();
    }
    drop(store);
    let store = Store::open(&dir.path().join("workspace.db")).unwrap();
    let sent = send(&store, "send", json!({}));
    assert_eq!(
        frozen(&store, &sent["message"])["effective"]["acceptance"],
        "Must survive older clients"
    );
    edit(&store, "clear", json!({"materials":null}));
    assert!(task(&store)["task"]["materials"].is_null());
    let sent = send(&store, "send-clear", json!({}));
    assert_eq!(frozen(&store, &sent["message"])["effective"], json!({}));
}

#[test]
fn gui_and_legacy_dispatches_remain_usable_without_fabricated_recipients() {
    let (_dir, store) = fixture();
    let sent = store
        .collaboration_call(
            None,
            "task_dispatch",
            json!({"requestId":"gui","taskId":"T-1","expectedVersion":1,"toAgentId":"dev"}),
        )
        .unwrap();
    assert!(frozen(&store, &sent["message"])["returnTo"].is_null());
    let db = store.db.write().unwrap();
    db.execute("UPDATE collaboration_task_activity SET data=json_remove(data,'$.materials') WHERE json_extract(data,'$.kind')='dispatched'",[]).unwrap();
    drop(db);
    assert!(
        store
            .collaboration_call(None, "task_get", json!({"taskId":"T-1"}))
            .is_ok()
    );
    assert!(
        store
            .collaboration_call(
                None,
                "task_get",
                json!({"taskId":"T-1","dispatchId":sent["message"]["dispatchId"]})
            )
            .is_err()
    );
}

/// T-131: materials keep full SHAs of either length. The store itself takes
/// full SHAs only: an abbreviation is resolved before it, in the materials'
/// repository (commit_sha::resolve_materials, T-164), and nothing guesses one.
#[test]
fn materials_take_full_shas_of_either_length_and_say_how_to_get_one() {
    let (_dir, store) = fixture();
    repos(&store);
    for sha in ["a".repeat(40), "b".repeat(64)] {
        edit(&store, &format!("full-{}", sha.len()), json!({"materials":{"repositoryId":2,"baseSha":sha,"headSha":sha}}));
        assert_eq!(task(&store)["task"]["materials"]["headSha"], sha);
    }
    for (index, sha) in ["e635e5e", "main", &"a".repeat(41)].into_iter().enumerate() {
        let before = task(&store);
        let error = store.collaboration_call(None, "task_update", json!({"requestId":format!("short-{index}"),"taskId":"T-1",
            "expectedVersion":before["task"]["version"],"patch":{"materials":{"repositoryId":2,"headSha":sha}}})).unwrap_err().to_string();
        assert!(error.starts_with("invalid_input: headSha must be a full commit SHA, 40 hexadecimal characters, or 64"), "{error}");
        assert!(error.contains("git rev-parse") && error.contains("github_links"), "{error}");
        assert_eq!(task(&store), before);
    }
    let schema = schema();
    assert!(schema["properties"]["baseSha"]["description"].as_str().unwrap().contains("64 in a SHA-256 repository"));
    assert_eq!(schema["properties"]["headSha"]["pattern"], "^([0-9a-fA-F]{4,40}|[0-9a-fA-F]{64})$");
}
