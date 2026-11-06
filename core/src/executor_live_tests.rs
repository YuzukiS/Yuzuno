use crate::executor_lifecycle::tests::{role, task};
use crate::{github::client::Repository, model::AgentDetail, store::Store};
use serde_json::{json, Value};

fn store() -> (tempfile::TempDir, Store) {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    (dir, store)
}

fn executor(store: &Store, id: &str, task: &str) {
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),"cwd":"/synthetic/work",
        "model":"","harness":"codex","color":"sage","status":"idle","createdAt":"now","updatedAt":"now",
        "unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
    role(store, id, task, "user", &format!("d-{id}"), "running", None);
}

fn link(store: &Store, task: &str, number: u64, state: &str, head: &str, ci: Value) -> String {
    let repo = Repository { id: 7, full_name: "owner/repo".into() };
    store.github_link_object(task, &repo, "pull", number, json!({"title":format!("PR {number}"),"state":state,
        "baseSha":"a".repeat(40),"headSha":head,"baseBranch":"main","ci":ci})).unwrap();
    store.db.read().unwrap().query_row("SELECT id FROM github_objects WHERE number=?1", [number], |r| r.get(0)).unwrap()
}

/// A review round of `task`'s PR link `link` at `head`: `status`, and with a
/// started reviewer, `conclusion`.
fn review(store: &Store, task: &str, link: &str, id: &str, head: &str, status: &str, conclusion: Option<&str>) -> Value {
    let start = serde_json::from_value(json!({"requestId":id,"notifyAgentId":null,"taskId":task,"linkId":link,
        "baseSha":null,"headSha":null})).unwrap();
    let (run, _) = store.create_pr_review(None, &start, id).unwrap();
    ended(store, run, head, status, conclusion)
}

/// `run` saved again as `status`, with its reviewer's `conclusion` if any.
fn ended(store: &Store, mut run: Value, head: &str, status: &str, conclusion: Option<&str>) -> Value {
    run["status"] = json!(status);
    run["headSha"] = json!(head);
    if let Some(conclusion) = conclusion {
        run["conclusion"] = json!(conclusion);
        run["actualHarness"] = json!("codex");
    }
    store.save_pr_review(&run, None).unwrap();
    run
}

fn pr(store: &Store, agent: &str) -> Value {
    store.executors_live().unwrap()["executors"][agent]["pr"].clone()
}

/// T-43 S2: the sidebar's PR chip for each open executor, from Core's own
/// records: the open PR with the highest number (a sliced task's merged PRs
/// come before it), the CI on its head and only that head's review rounds.
#[test]
fn an_open_executor_shows_its_tasks_open_pr_with_ci_and_rounds_on_its_head() {
    let (_dir, s) = store();
    let (public, internal) = task(&s, "Sliced work");
    executor(&s, "e1", &internal);
    let (old, head) = ("1".repeat(40), "2".repeat(40));
    link(&s, &public, 2, "merged", &old, json!({"state":"success","headSha":old}));
    let open = link(&s, &public, 3, "open", &head, json!({"state":"success","headSha":head}));
    link(&s, &public, 1, "closed", &old, Value::Null);
    let shown = pr(&s, "e1");
    assert_eq!((shown["number"].clone(), shown["state"].clone(), shown["ci"].clone()), (json!(3), json!("open"), json!("success")), "{shown}");
    assert_eq!(shown["url"], "https://github.com/owner/repo/pull/3");
    assert_eq!(shown["reviews"], json!({"approved":0,"changesRequested":false,"running":false}));

    // A round on an older head counts for nothing here; a failed preparation
    // that started no reviewer is no round; one under way is said.
    review(&s, &public, &open, "r0", &old, "completed", Some("no_findings"));
    review(&s, &public, &open, "r1", &head, "completed", Some("approved_with_notes"));
    review(&s, &public, &open, "r2", &head, "failed", None);
    let running = review(&s, &public, &open, "r3", &head, "running", None);
    assert_eq!(pr(&s, "e1")["reviews"], json!({"approved":1,"changesRequested":false,"running":true}));
    ended(&s, running, &head, "completed", Some("changes_requested"));
    assert_eq!(pr(&s, "e1")["reviews"], json!({"approved":0,"changesRequested":true,"running":false}), "a request for changes starts over");
}

/// T-43 S2: a CI state Core last saw for another commit says nothing of this
/// head; with no open PR the newest one is shown; and only open executors
/// with a linked PR are listed.
#[test]
fn ci_of_another_head_is_unknown_and_only_open_executors_with_a_pr_are_listed() {
    let (_dir, s) = store();
    let (public, internal) = task(&s, "Delivered work");
    executor(&s, "e1", &internal);
    let head = "3".repeat(40);
    link(&s, &public, 5, "merged", &head, json!({"state":"success","headSha":"4".repeat(40)}));
    link(&s, &public, 4, "merged", &head, Value::Null);
    let shown = pr(&s, "e1");
    assert_eq!((shown["number"].clone(), shown["state"].clone(), shown["ci"].clone()), (json!(5), json!("merged"), json!("unknown")), "{shown}");

    let (_, bare) = task(&s, "No PR yet");
    executor(&s, "e2", &bare);
    let (archived_public, archived) = task(&s, "Archived work");
    executor(&s, "e3", &archived);
    link(&s, &archived_public, 6, "open", &head, Value::Null);
    s.db.write().unwrap().execute("UPDATE agent_roles SET archived_at='then' WHERE agent_id='e3'", []).unwrap();
    let (closed_public, closed) = task(&s, "Closed work");
    executor(&s, "e4", &closed);
    link(&s, &closed_public, 7, "open", &head, Value::Null);
    s.update("e4", "test/closed", &json!({}), |d| d.agent.closed_at = Some(crate::model::now())).unwrap();
    let listed = s.executors_live().unwrap()["executors"].as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    assert_eq!(listed, vec!["e1".to_owned()], "no PR, archived and closed executors are not listed");
}
