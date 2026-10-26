use crate::{github::client::Repository, model::AgentDetail, store::Store};
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    s.insert(&serde_json::from_value::<AgentDetail>(json!({"agent":{"id":"a","name":"Dev","cwd":"/workspace","model":"test",
        "color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,
        "reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
    (dir, s)
}

fn call(s: &Store, operation: &str, input: Value) -> Value {
    s.collaboration_call(None, operation, input).unwrap()
}

fn list(s: &Store, mut input: Value, compact: bool) -> Value {
    if compact {
        input["compact"] = json!(true);
    }
    call(s, "task_list", input)
}

/// A synthetic task shaped like a long-running one: a long description and
/// progress, a submitted result, and `links` GitHub objects with snapshots.
/// No real task text is used.
fn long_task(s: &Store, n: u64, links: u64) -> String {
    let created = call(s, "task_create", json!({"requestId":format!("c{n}"),"title":format!("Synthetic task {n}"),
        "description":format!("Goal {n}. {}", "Synthetic description sentence. ".repeat(110)),"assigneeAgentId":"a"}));
    let id = created["task"]["id"].as_str().unwrap().to_owned();
    let updated = call(s, "task_update", json!({"requestId":format!("u{n}"),"taskId":id,"expectedVersion":created["task"]["version"],
        "patch":{"status":"doing","progress":format!("Step {n}. {}", "Synthetic progress note. ".repeat(40)),"blocker":"waiting on a review"}}));
    s.collaboration_call(Some("a"), "task_submit_result", json!({"requestId":format!("r{n}"),"taskId":id,
        "expectedVersion":updated["task"]["version"],"summary":format!("Synthetic result {n}. {}", "Synthetic result line. ".repeat(150)),
        "links":[{"label":"Synthetic PR","url":"https://example.invalid/pull/1"}]})).unwrap();
    let repo = Repository { id: 7, full_name: "owner/repo".into() };
    for k in 0..links {
        s.github_link_object(&id, &repo, "pull", n * 100 + k, json!({"title":format!("Synthetic PR {n}.{k}"),"state":"open",
            "baseSha":"a".repeat(40),"headSha":"b".repeat(40),"baseBranch":"main","body":"Synthetic body. ".repeat(60),
            "ci":{"state":"success","headSha":"b".repeat(40),"complete":true,"observedAt":"then"}})).unwrap();
    }
    id
}

fn keys(row: &Value) -> BTreeSet<String> {
    row.as_object().unwrap().keys().cloned().collect()
}

#[test]
fn compact_rows_are_short_count_links_and_leave_the_whole_task_to_task_get() {
    let (_dir, s) = store();
    long_task(&s, 1, 2);
    long_task(&s, 2, 0);
    let full = list(&s, json!({}), false);
    let compact = list(&s, json!({}), true);

    // The default answer is as before: every field, GitHub snapshots, no note.
    let whole = &full["tasks"][0];
    assert!(whole["description"].as_str().unwrap().len() > 3000 && whole["result"]["summary"].is_string());
    assert_eq!(whole["github"].as_array().unwrap().len(), 2);
    assert!(full.get("compact").is_none(), "an old call's answer gains nothing");

    // A compact row has only these fields; links are a count.
    let row = &compact["tasks"][0];
    let want: BTreeSet<String> = ["id", "seq", "title", "status", "version", "assignee", "updatedAt", "progress", "blocker",
        "archivedAt", "projectId", "githubLinks"].into_iter().map(String::from).collect();
    assert_eq!(keys(row), want, "{row}");
    assert_eq!((row["id"].clone(), row["githubLinks"].clone()), (json!("T-1"), json!(2)));
    assert_eq!(compact["tasks"][1]["githubLinks"], 0);
    assert_eq!((row["status"].clone(), row["version"].clone(), row["title"].clone()),
        (whole["status"].clone(), whole["version"].clone(), whole["title"].clone()));
    assert_eq!((row["assignee"].clone(), row["updatedAt"].clone()), (whole["assignee"].clone(), whole["updatedAt"].clone()));
    // Progress is cut at 200 characters and says how much more there is; a
    // short blocker is whole.
    let progress = row["progress"].as_str().unwrap();
    let original = whole["progress"].as_str().unwrap();
    assert!(progress.starts_with(&original[..200]) && progress.contains("more characters: task_get]"), "{progress}");
    assert_eq!(row["blocker"], "waiting on a review");
    assert!(compact["compact"].as_str().unwrap().contains("task_get reads one task whole"));

    // Counts and paging are the default's.
    for key in ["counts", "nextAfterSeq", "hasMore"] {
        assert_eq!(compact[key], full[key], "{key}");
    }
    // What a row leaves out is still there in the task itself.
    let one = call(&s, "task_get", json!({"taskId":"T-1"}));
    assert_eq!(one["task"]["description"], whole["description"]);
    assert_eq!(one["task"]["progress"], whole["progress"]);
}

#[test]
fn compact_pages_and_filters_exactly_like_the_default() {
    let (_dir, s) = store();
    for (n, status) in [(1, "todo"), (2, "doing"), (3, "blocked"), (4, "doing"), (5, "review"), (6, "todo"), (7, "doing")] {
        let mut input = json!({"requestId":format!("c{n}"),"title":format!("Item {n} {}", if n % 2 == 0 { "alpha" } else { "beta" }),"status":status});
        if n > 3 {
            input["assigneeAgentId"] = json!("a");
        }
        call(&s, "task_create", input);
    }
    let archived = call(&s, "task_get", json!({"taskId":"T-6"}))["task"]["version"].clone();
    call(&s, "task_update", json!({"requestId":"arch","taskId":"T-6","expectedVersion":archived,"patch":{"archived":true}}));
    let inputs = [json!({}), json!({"status":"doing"}), json!({"statuses":["todo","blocked"]}), json!({"assigneeAgentId":"a"}),
        json!({"archived":true}), json!({"query":"alpha"}), json!({"projectId":null}), json!({"statuses":["doing"],"assigneeAgentId":"a"})];
    for filter in inputs {
        let mut after = 0;
        loop {
            let mut input = filter.clone();
            input["afterSeq"] = json!(after);
            input["limit"] = json!(2);
            let (full, compact) = (list(&s, input.clone(), false), list(&s, input, true));
            let ids = |page: &Value| page["tasks"].as_array().unwrap().iter().map(|t| t["id"].clone()).collect::<Vec<_>>();
            assert_eq!(ids(&compact), ids(&full), "{filter}");
            for key in ["counts", "nextAfterSeq", "hasMore"] {
                assert_eq!(compact[key], full[key], "{filter} {key}");
            }
            if full["hasMore"] != true {
                break;
            }
            after = full["nextAfterSeq"].as_i64().unwrap();
        }
    }
}

#[test]
fn compact_must_be_a_boolean() {
    let (_dir, s) = store();
    let error = s.collaboration_call(None, "task_list", json!({"compact":"yes"})).unwrap_err().to_string();
    assert!(error.contains("invalid_input"), "{error}");
}

/// The bounded synthetic sample the report measures (T-201): 12 tasks shaped
/// like long-running ones, each with a long description and progress, a
/// result and 3 GitHub links. Prints both answers' JSON bytes and the time to
/// build them; asserts only that the compact page is far smaller.
#[test]
fn the_synthetic_page_is_much_smaller_compact() {
    let (_dir, s) = store();
    for n in 1..=12 {
        long_task(&s, n, 3);
    }
    let measure = |compact: bool| {
        let started = std::time::Instant::now();
        let mut bytes = 0;
        for _ in 0..20 {
            bytes = serde_json::to_vec(&list(&s, json!({}), compact)).unwrap().len();
        }
        (bytes, started.elapsed().as_micros() / 20)
    };
    let ((full_bytes, full_us), (compact_bytes, compact_us)) = (measure(false), measure(true));
    println!("T201-MEASURE {}", json!({"tasks":12,"linksPerTask":3,"fullBytes":full_bytes,"compactBytes":compact_bytes,
        "fullMicrosPerCall":full_us,"compactMicrosPerCall":compact_us,"build":"test profile"}));
    assert!(compact_bytes * 10 < full_bytes, "{compact_bytes} vs {full_bytes}");
}
