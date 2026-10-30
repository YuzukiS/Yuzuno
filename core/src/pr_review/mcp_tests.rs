use super::*;
use crate::{github::client::Repository, store::Store};

/// Validate the JSON Schema keywords used in this contract. This checks real
/// Store output (including legacy rows and errors), without a new runtime dep.
fn conforms(schema: &Value, value: &Value) -> bool {
    let matches_type = |kind: &str| match kind {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" => value.is_i64() || value.is_u64(),
        "null" => value.is_null(),
        _ => panic!("unhandled schema type: {kind}"),
    };
    if let Some(kinds) = schema.get("type") {
        let valid = match kinds {
            Value::String(kind) => matches_type(kind),
            Value::Array(kinds) => kinds
                .iter()
                .any(|kind| matches_type(kind.as_str().unwrap())),
            _ => panic!("invalid type"),
        };
        if !valid {
            return false;
        }
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(choices) = schema[key].as_array() {
            let matching = choices.iter().filter(|s| conforms(s, value)).count();
            if matching == 0 || (key == "oneOf" && matching != 1) {
                return false;
            }
        }
    }
    if let Some(choices) = schema["enum"].as_array() {
        if !choices.contains(value) {
            return false;
        }
    }
    if let Some(object) = value.as_object() {
        if schema["required"].as_array().is_some_and(|keys| {
            keys.iter()
                .any(|key| !object.contains_key(key.as_str().unwrap()))
        }) {
            return false;
        }
        for (key, value) in object {
            match schema["properties"].get(key) {
                Some(property) if !conforms(property, value) => return false,
                None if schema["additionalProperties"] == false => return false,
                _ => (),
            }
        }
    }
    if let Some(array) = value.as_array() {
        if schema["maxItems"]
            .as_u64()
            .is_some_and(|max| array.len() as u64 > max)
        {
            return false;
        }
        if let Some(item) = schema.get("items") {
            if array.iter().any(|value| !conforms(item, value)) {
                return false;
            }
        }
    }
    true
}

fn setup() -> (tempfile::TempDir, Store, String) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let task = store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"create","title":"Synthetic review"}),
        )
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let task = crate::collaboration_store::task_key(&store.db.read().unwrap(), &task)
        .unwrap()
        .0;
    store
        .github_link_object(
            &task,
            &Repository {
                id: 7,
                full_name: "example/repo".into(),
            },
            "pull",
            1,
            json!({"baseSha":"a".repeat(40),"headSha":"b".repeat(40)}),
        )
        .unwrap();
    (dir, store, task)
}

fn insert(store: &Store, task: &str, id: &str, round: u64) {
    let data = json!({"id":id,"reviewId":id,"taskId":task,"linkId":"7:pull:1","round":round,
        "status":"completed","conclusion":"unknown","policyVersion":3,"coveragePolicyVersion":3,
        "reasonCodes":["coverage_incomplete","unsupported_source"],
        "baseSha":"a".repeat(40),"headSha":"b".repeat(40),"mergeBaseSha":"c".repeat(40),
        "actualHarness":"codex","contextIncomplete":true,"acknowledgedUnreviewable":true,
        "findings":[{"priority":2,"title":"Blocking finding","body":"heavy body ".repeat(4000)}],
        "settledFindings":[{"title":"fixed","body":"prior finding"}],
        "ledger":{"nativeCompletion":"confirmed","events":["heavy ledger ".repeat(4000)]},
        "contextReads":[{"path":"source.rs","response":"heavy source ".repeat(4000)}],
        "files":[{"path":"source.rs","patch":"heavy diff ".repeat(4000)}],
        "coverage":{"fileCount":10,"coveredFileCount":5,"deliveredCompleteDiffs":4,
            "uninspected":[{"path":"asset.bin"},{"path":"a.rs"},{"path":"b.rs"},{"path":"c.rs"},{"path":"d.rs"}],
            "failedRequests":[{"requested":{"path":"source.rs"},"resolved":false}],
            "unresolvedRequests":1,"terminalLimit":"context_bytes","coveredFiles":[{"path":"covered.rs","proof":"source_diff"}]},
        "scope":{"counts":{"covered":5,"excluded":1,"unsupported":1,"budget_exhausted":1,"read_failed":1,"not_read":1},
            "checkAfterReview":"interrupted","paths":[{"path":"asset.bin","state":"unsupported"}]}});
    store.db.write().unwrap().execute("INSERT INTO pr_reviews(id,task_id,link_id,status,data,report) VALUES(?1,?2,'7:pull:1','completed',?3,?4)",
        rusqlite::params![id,task,data.to_string(),"heavy raw report ".repeat(4000)]).unwrap();
}

#[test]
fn compact_page_retains_decisions_and_omits_heavy_evidence_while_gui_and_detail_keep_it() {
    let (_dir, store, task) = setup();
    insert(&store, &task, "r1", 1);
    let compact = store.list_pr_review_summaries("T-1", None).unwrap();
    let gui = store.list_pr_reviews("T-1", None).unwrap();
    assert!(conforms(&list_schema(), &compact), "{compact}");
    for key in ["settings", "hasMore", "nextBefore"] {
        assert_eq!(compact[key], gui[key]);
    }
    let row = &compact["reviews"][0];
    assert_eq!(row["reviewId"], "r1");
    assert_eq!(
        (
            row["baseSha"].clone(),
            row["headSha"].clone(),
            row["mergeBaseSha"].clone()
        ),
        (
            json!("a".repeat(40)),
            json!("b".repeat(40)),
            json!("c".repeat(40))
        )
    );
    assert_eq!(
        (
            row["outdated"].clone(),
            row["conclusion"].clone(),
            row["contextIncomplete"].clone()
        ),
        (json!(false), json!("unknown"), json!(true))
    );
    assert_eq!(row["acknowledgedUnreviewable"], true);
    assert_eq!(row["scopeCheckAfterReview"], "interrupted");
    assert_eq!(row["findingsCount"], 1);
    assert_eq!(row["settledFindingsCount"], 1);
    assert_eq!(row["coverage"]["coveredFileCount"], 5);
    assert_eq!(row["coverage"]["deliveredCompleteDiffs"], 4);
    assert_eq!(row["coverage"]["uninspectedCount"], 5);
    assert_eq!(row["coverage"]["failedRequestCount"], 1);
    assert_eq!(row["coverage"]["unresolvedRequests"], 1);
    assert_eq!(row["coverage"]["terminalLimit"], "context_bytes");
    assert_eq!(row["scopeCounts"]["unsupported"], 1);
    for gone in [
        "rawReport",
        "findings",
        "settledFindings",
        "contextReads",
        "files",
        "ledger",
        "scope",
        "evidence",
    ] {
        assert!(row.get(gone).is_none(), "{gone}");
    }
    assert!(!compact.to_string().contains("heavy"));
    assert!(compact.to_string().len() < gui.to_string().len() / 50);
    let full = store.pr_review_report("T-1", "r1").unwrap();
    assert!(full["rawReport"]
        .as_str()
        .unwrap()
        .contains("heavy raw report"));
    assert_eq!(full["contextReads"], gui["reviews"][0]["contextReads"]);
    assert_eq!(full["coverage"], gui["reviews"][0]["coverage"]);
    assert_eq!(full["ledger"], gui["reviews"][0]["ledger"]);
    let summary = crate::mcp_views::answer("review_get", full.clone(), Some("summary"));
    assert_eq!(summary["findings"], full["findings"]);
    assert_eq!(summary["scope"]["notCovered"][0]["path"], "asset.bin");
    assert_eq!(summary["policyVersion"], 3);
    assert_eq!(summary["coveragePolicyVersion"], 3);
    assert_eq!(
        crate::mcp_views::answer("review_get", full.clone(), Some("full")),
        full
    );
    store
        .github_refresh_object(
            "7:pull:1",
            Ok((
                Repository {
                    id: 7,
                    full_name: "example/repo".into(),
                },
                json!({"baseSha":"d".repeat(40),"headSha":"b".repeat(40)}),
            )),
        )
        .unwrap();
    let changed = store.list_pr_review_summaries("T-1", None).unwrap();
    assert_eq!(changed["reviews"][0]["outdated"], true);
    assert!(conforms(&list_schema(), &changed));
}

#[test]
fn compact_pages_keep_task_identity_order_and_cursors_across_new_insertions() {
    let (_dir, store, task) = setup();
    for i in 1..=45 {
        insert(&store, &task, &format!("r{i}"), i);
    }
    let other = store
        .collaboration_call(
            None,
            "task_create",
            json!({"requestId":"other","title":"Another task"}),
        )
        .unwrap()["task"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let other = crate::collaboration_store::task_key(&store.db.read().unwrap(), &other)
        .unwrap()
        .0;
    insert(&store, &other, "other-review", 1);
    let mut seen = Vec::new();
    let mut before = None;
    for expected in [20, 20, 5] {
        let page = store.list_pr_review_summaries("T-1", before).unwrap();
        assert!(conforms(&list_schema(), &page));
        let rows = page["reviews"].as_array().unwrap();
        assert_eq!(rows.len(), expected);
        assert_eq!(page["hasMore"], expected == 20);
        assert!(rows.iter().all(|row| row["taskId"] == task));
        seen.extend(
            rows.iter()
                .map(|row| row["reviewId"].as_str().unwrap().to_owned()),
        );
        before = page["nextBefore"].as_i64();
        if seen.len() == 20 {
            insert(&store, &task, "new-after-first-page", 46);
        }
    }
    assert_eq!(
        seen,
        (1..=45).rev().map(|i| format!("r{i}")).collect::<Vec<_>>()
    );
    assert_eq!(
        store.list_pr_review_summaries("T-1", None).unwrap()["reviews"][0]["reviewId"],
        "new-after-first-page"
    );
    let empty = store.list_pr_review_summaries("T-1", before).unwrap();
    assert_eq!(
        (
            empty["reviews"].clone(),
            empty["hasMore"].clone(),
            empty["nextBefore"].clone()
        ),
        (json!([]), json!(false), Value::Null)
    );
    assert!(conforms(&list_schema(), &empty));
    assert!(store.pr_review_report("T-1", "other-review").is_err());
    assert!(store.list_pr_review_summaries("T-99", None).is_err());
}

#[test]
fn failed_unprepared_and_legacy_rows_never_turn_unknown_into_zero_or_current() {
    let (_dir, store, task) = setup();
    let legacy = json!({"id":"legacy","taskId":task,"linkId":"7:pull:1","round":1,"status":"failed",
        "conclusion":"unknown","error":"fixed revision fetch failed","actualHarness":null,
        "requestedBaseSha":"a".repeat(40),"requestedHeadSha":"b".repeat(40)});
    store.db.write().unwrap().execute("INSERT INTO pr_reviews(id,task_id,link_id,status,data) VALUES('legacy',?1,'7:pull:1','failed',?2)",
        rusqlite::params![task,legacy.to_string()]).unwrap();
    let page = store.list_pr_review_summaries("T-1", None).unwrap();
    assert!(conforms(&list_schema(), &page));
    let row = &page["reviews"][0];
    assert_eq!(row["reviewId"], "legacy");
    assert_eq!(row["reviewerStarted"], false);
    assert_eq!(row["error"], "fixed revision fetch failed");
    assert_eq!(row["requestedHeadSha"], "b".repeat(40));
    for unknown in [
        "outdated",
        "coverage",
        "scopeCounts",
        "findingsCount",
        "contextIncomplete",
    ] {
        assert_eq!(row.get(unknown), Some(&Value::Null), "{unknown}");
    }
    let summary = crate::mcp_views::answer(
        "review_get",
        store.pr_review_report("T-1", "legacy").unwrap(),
        None,
    );
    assert_eq!(summary.get("outdated"), Some(&Value::Null));
    let old_coverage = list_row(
        &json!({"coverage":{"fileCount":2,"deliveredCompleteDiffs":1,"uninspected":[{"path":"a"}]}}),
    );
    assert_eq!(old_coverage["coverage"]["coveredFileCount"], Value::Null);
    assert_eq!(old_coverage["coverage"]["uninspectedCount"], 1);
    assert_eq!(list_row(&json!({}))["reviewerStarted"], Value::Null);
}

#[test]
fn list_contract_covers_tool_errors_and_rejects_missing_paging_or_leaked_evidence() {
    let schema = list_schema();
    assert!(conforms(&schema, &json!({"error":"No such task"})));
    assert!(!conforms(&schema, &json!({"error":null})));
    assert!(!conforms(
        &schema,
        &json!({"error":"No such task","reviews":[]})
    ));
    let (_dir, store, task) = setup();
    insert(&store, &task, "r", 1);
    let page = store.list_pr_review_summaries("T-1", None).unwrap();
    let mut bad = page.clone();
    bad.as_object_mut().unwrap().remove("hasMore");
    assert!(!conforms(&schema, &bad));
    bad = page.clone();
    bad["reviews"][0]["outdated"] = json!("unknown");
    assert!(!conforms(&schema, &bad));
    bad = page;
    bad["reviews"][0]["contextReads"] = json!([]);
    assert!(!conforms(&schema, &bad));
    let definitions = super::super::tool_definitions();
    for definition in definitions {
        let tool: rmcp::model::Tool = serde_json::from_value(definition.clone()).unwrap();
        let wire = serde_json::to_value(tool).unwrap();
        match definition["name"].as_str().unwrap() {
            "review_list" => assert_eq!(wire["outputSchema"], schema),
            _ => assert!(wire.get("outputSchema").is_none()),
        }
        match definition["name"].as_str().unwrap() {
            "review_list" | "review_get" => assert_eq!(
                wire["annotations"],
                json!({"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":false})
            ),
            _ => assert!(wire.get("annotations").is_none()),
        }
    }
}
