//! T-153: five Agent operations, measured before (the call forms Agents used
//! and the answers they got: the store's whole records, as MCP passed them on)
//! and after (the same call forms, now through `prepare` and `answer`, the way
//! collaboration_mcp.rs calls them). A synthetic task whose history grows: per
//! operation the calls, the characters of the JSON the Agent reads, server
//! time (sum of each call's median of 7) and the calls refused for their
//! parameters. Characters, not tokens; no client or model time. Run explicitly:
//! `cargo test --lib mcp_views::measure -- --ignored --nocapture`.
use crate::{github::client::Repository, mcp_views, model::AgentDetail, store::Store};
use serde_json::{json, Value};
use std::time::Instant;

fn agent(s: &Store, id: &str) {
    s.insert(&serde_json::from_value::<AgentDetail>(json!({"agent":{"id":id,"name":id,"cwd":"/workspace","model":"test",
        "color":"sage","status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,
        "reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap()).unwrap();
}

struct Seeded {
    _dir: tempfile::TempDir,
    s: Store,
    dispatch: String,
    head: String,
}

/// A task as these runs look: a dispatch with materials, a long history of
/// notes and task mail, Lead's progress, a PR whose review asked for changes,
/// CI on its head, and a main/push watch on the merge commit.
fn seed(history: usize) -> Seeded {
    let dir = tempfile::tempdir().unwrap();
    let s = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    for id in ["lead", "dev"] {
        agent(&s, id);
    }
    s.collaboration_call(Some("lead"), "task_create", json!({"requestId":"c","title":"Open a project's services",
        "description":"d".repeat(700),"materials":{"acceptance":"a".repeat(2400),"returnRequirements":"r".repeat(1100),
        "baseline":"b".repeat(600)}})).unwrap();
    let dispatched = s.collaboration_call(Some("lead"), "task_dispatch", json!({"requestId":"d","taskId":"T-1",
        "expectedVersion":1,"toAgentId":"dev","body":"Take it from main."})).unwrap();
    let dispatch = dispatched["task"]["dispatch"]["id"].as_str().unwrap().to_owned();
    for n in 0..history {
        if n % 10 == 0 {
            s.collaboration_call(Some("dev"), "peer_send", json!({"requestId":format!("m{n}"),"toAgentId":"lead",
                "taskId":"T-1","body":format!("status {n} {}", "m".repeat(400))})).unwrap();
        }
        s.collaboration_call(Some(if n % 3 == 0 { "lead" } else { "dev" }), "task_comment", json!({"requestId":format!("n{n}"),
            "taskId":"T-1","body":format!("note {n} {}", "x".repeat(600))})).unwrap();
    }
    s.collaboration_call(Some("lead"), "task_update", json!({"requestId":"p","taskId":"T-1","expectedVersion":version(&s),
        "patch":{"progress":"p".repeat(1800)}})).unwrap();
    let repo = Repository { id: 7, full_name: "owner/repo".into() };
    let (base, head) = ("a".repeat(40), "b".repeat(40));
    s.github_link_object("T-1", &repo, "pull", 14, json!({"title":"Project services","state":"open","baseSha":base,
        "headSha":head,"baseBranch":"main","headBranch":"feat","ci":{"state":"success","headSha":head,"complete":true,
        "observedAt":"now","checks":[{"name":"Core","state":"success"},{"name":"Web","state":"success"}]}})).unwrap();
    let link = s.collaboration_call(None, "task_get", json!({"taskId":"T-1","view":"current"})).unwrap()
        ["current"]["delivery"]["pullRequests"][0]["linkId"].clone();
    let start = serde_json::from_value(json!({"requestId":"r","notifyAgentId":null,"taskId":"T-1","linkId":link,
        "baseSha":null,"headSha":null})).unwrap();
    let (mut run, _) = s.create_pr_review(Some("dev"), &start, "r").unwrap();
    let path = |n: usize| format!("core/src/f{n}.rs");
    run["status"] = json!("completed");
    run["conclusion"] = json!("changes_requested");
    run["headSha"] = json!(head);
    run["baseSha"] = json!(base);
    run["explanation"] = json!("e".repeat(700));
    run["actualHarness"] = json!("codex");
    run["actualModel"] = json!("model");
    run["findings"] = json!([{"priority":2,"title":"Deleting a project leaves its services open","body":"f".repeat(900),"path":path(1)},
        {"priority":3,"title":"A busy port loses its reason","body":"g".repeat(500),"path":path(2)}]);
    run["contextReads"] = Value::Array((0..30).map(|n| json!({"number":n,"tool":"source_read","path":path(n % 16),
        "blobSha":"c".repeat(40),"revision":head,"startLine":1,"endLine":400})).collect());
    run["files"] = Value::Array((0..16).map(|n| json!({"path":path(n),"status":"modified","lines":900,
        "sourceBlob":"c".repeat(40),"sourceRevision":head})).collect());
    run["coverage"] = json!({"fileCount":16,"coveredFileCount":15,"uninspected":[path(15)],"failedRequests":[],"unresolvedRequests":0,
        "coveredFiles":(0..15).map(|n| json!({"path":path(n),"evidenceKind":"complete_diff","blobSha":"c".repeat(40)})).collect::<Vec<_>>()});
    let mut paths: Vec<Value> = (0..15).map(|n| json!({"path":path(n),"state":"covered","status":"modified","facts":[{"kind":"covered"}]})).collect();
    paths.push(json!({"path":path(15),"state":"uninspected","status":"modified","facts":[{"kind":"budget"}]}));
    run["scope"] = json!({"counts":{"covered":15,"uninspected":1},"policy":{"state":"absent"},"paths":paths});
    s.save_pr_review(&run, Some(&json!({"result":"r".repeat(9000)}).to_string())).unwrap();
    let subscribe = |request: &str, url: String, sha: &str, kind: &str, number: u64, branch: Option<&str>| {
        let input = serde_json::from_value(json!({"requestId":request,"taskId":"T-1","agentId":null,"url":url,
            "expectedSha":sha,"branch":branch,"event":branch.map(|_| "push")})).unwrap();
        s.ci_subscribe(Some("dev"), input, repo.clone(), kind, number).unwrap()
    };
    let merge = "d".repeat(40);
    let pr = subscribe("ci-pr", "https://github.com/owner/repo/pull/14".into(), &head, "pull", 14, None);
    let main = subscribe("ci-main", format!("https://github.com/owner/repo/commit/{merge}"), &merge, "commit", 0, Some("main"));
    for (n, watch, sha, event, branch) in [(1, &pr, &head, "pull_request", "feat"), (2, &main, &merge, "push", "main")] {
        let observed = json!({"id":format!("github:7:{n}:1"),"source":"github_actions","repositoryId":7,"repository":"owner/repo",
            "runId":n.to_string(),"attempt":"1","headSha":sha,"name":"CI","status":"passed","rawStatus":"completed",
            "conclusion":"success","event":event,"branch":branch,"observedAt":"now",
            "url":format!("https://github.com/owner/repo/actions/runs/{n}/attempts/1")});
        s.ci_observe(watch["watchId"].as_str().unwrap(), Ok(crate::ci_monitor::Observed { runs: vec![observed],
            head: Some(sha.clone()), pr: None, truncated: false, checked: chrono::Utc::now().timestamp(), wait: 0,
            excluded: 0 })).unwrap();
    }
    Seeded { _dir: dir, s, dispatch, head }
}

fn version(s: &Store) -> i64 {
    s.collaboration_call(None, "task_get", json!({"taskId":"T-1","view":"current"})).unwrap()["current"]["version"].as_i64().unwrap()
}

/// What an Agent's call reached before T-153: the store, as MCP passed it on.
fn store(s: &Store, tool: &str, args: &Value) -> anyhow::Result<Value> {
    match tool {
        "review_get" => s.pr_review_report(args["taskId"].as_str().unwrap(), args["reviewId"].as_str().unwrap()),
        "ci_list" => s.ci_list(None, args["taskId"].as_str(), None),
        _ => s.collaboration_call(Some("dev"), tool, args.clone()),
    }
}

/// The same call now, through collaboration_mcp.rs's `prepare` and `answer`.
fn now(s: &Store, tool: &str, args: &Value) -> anyhow::Result<Value> {
    let mut arguments = args.as_object().unwrap().clone();
    let view = mcp_views::prepare(tool, &mut arguments).map_err(anyhow::Error::msg)?;
    Ok(mcp_views::answer(tool, store(s, tool, &Value::Object(arguments))?, view.as_deref()))
}

struct Measured {
    calls: usize,
    chars: usize,
    ms: f64,
    errors: usize,
    answers: Vec<Value>,
}

/// Each call 7 times (a write with fresh arguments each time): its last answer,
/// its characters and its median time, summed over the operation's calls.
fn measure(s: &Store, calls: &[(&str, &dyn Fn(&Store) -> Value)], through: fn(&Store, &str, &Value) -> anyhow::Result<Value>) -> Measured {
    let mut out = Measured { calls: calls.len(), chars: 0, ms: 0.0, errors: 0, answers: Vec::new() };
    for (tool, args) in calls {
        let mut times = Vec::new();
        let mut last = Value::Null;
        for _ in 0..7 {
            let args = args(s);
            let started = Instant::now();
            let answer = through(s, tool, &args);
            times.push(started.elapsed().as_secs_f64() * 1000.0);
            match answer {
                Ok(answer) => last = answer,
                Err(error) => {
                    out.errors += 1;
                    last = json!({"error": error.to_string()});
                }
            }
        }
        times.sort_by(|a, b| a.partial_cmp(b).unwrap());
        out.chars += last.to_string().chars().count();
        out.ms += times[3];
        out.answers.push(last);
    }
    out
}

#[test]
#[ignore = "T-153 measurement of five Agent operations before and after; run explicitly"]
fn five_agent_operations_before_and_after() {
    let mut rows = Vec::new();
    for history in [50, 500, 3000] {
        let seeded = seed(history);
        let s = &seeded.s;
        let dispatch = seeded.dispatch.clone();
        let materials = move |_: &Store| json!({"taskId":"T-1","dispatchId":dispatch});
        let task = |_: &Store| json!({"taskId":"T-1"});
        let review = |_: &Store| json!({"taskId":"T-1","reviewId":"r"});
        let ci = |_: &Store| json!({"taskId":"T-1"});
        let submits = std::cell::Cell::new(0);
        let dispatch = seeded.dispatch.clone();
        let submit = move |s: &Store| {
            submits.set(submits.get() + 1);
            json!({"requestId":format!("result-{}", submits.get()),"taskId":"T-1","expectedVersion":version(s),
                "dispatchId":dispatch,"summary":format!("PR #14 at {}; CI and review on that head", "b".repeat(40)),
                "links":[{"label":"PR","url":"https://github.com/owner/repo/pull/14"}]})
        };
        // The call forms Agents use for each operation, before and after:
        // after T-153 confirming the head, its review and main's CI is the
        // current view alone.
        let operations: Vec<(&str, Vec<(&str, &dyn Fn(&Store) -> Value)>, Vec<(&str, &dyn Fn(&Store) -> Value)>)> = vec![
            ("take a dispatched task", vec![("task_get", &materials), ("task_get", &task)], vec![("task_get", &materials), ("task_get", &task)]),
            ("check progress", vec![("task_get", &task)], vec![("task_get", &task)]),
            ("read a failed review", vec![("review_get", &review)], vec![("review_get", &review)]),
            ("submit a result", vec![("task_submit_result", &submit)], vec![("task_submit_result", &submit)]),
            ("confirm head, review and main CI", vec![("task_get", &task), ("review_get", &review), ("ci_list", &ci)],
                vec![("task_get", &task)]),
        ];
        for (operation, before_calls, after_calls) in &operations {
            let before = measure(s, before_calls, store);
            let after = measure(s, after_calls, now);
            // An old caller's call forms, answered now: refused for parameters?
            let old_forms = measure(s, before_calls, now);
            assert_eq!((before.errors, after.errors, old_forms.errors), (0, 0, 0), "{operation}: {:?}", after.answers);
            evidence_is_kept(operation, &after.answers, &seeded);
            let row = json!({"history":history,"operation":operation,
                "before":{"calls":before.calls,"chars":before.chars,"serverMs":round(before.ms),"parameterErrors":before.errors},
                "after":{"calls":after.calls,"chars":after.chars,"serverMs":round(after.ms),"parameterErrors":after.errors},
                "oldCallFormsNow":{"parameterErrors":old_forms.errors}});
            println!("{row}");
            rows.push(row);
        }
    }
    if let Ok(path) = std::env::var("T153_MEASURE_OUT") {
        let path = std::path::Path::new(&path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, Value::Array(rows).to_string()).unwrap();
    }
}

fn round(ms: f64) -> f64 {
    (ms * 100.0).round() / 100.0
}

/// What each operation needs is in the shorter answer.
fn evidence_is_kept(operation: &str, answers: &[Value], seeded: &Seeded) {
    match operation {
        "take a dispatched task" => {
            assert!(answers[0]["dispatchMaterials"]["effective"]["acceptance"].as_str().unwrap().len() == 2400);
            let current = &answers[1]["current"];
            assert_eq!((current["dispatch"]["id"].as_str(), current["materialsRegistered"].clone()),
                (Some(seeded.dispatch.as_str()), json!(true)));
        }
        "check progress" => {
            let current = &answers[0]["current"];
            assert!(current["progress"].as_str().unwrap().starts_with("ppp") && current["latestActivity"]["seq"].is_i64());
        }
        "read a failed review" => {
            let review = &answers[0];
            assert_eq!((review["conclusion"].clone(), review["findings"].as_array().unwrap().len()), (json!("changes_requested"), 2));
            assert_eq!(review["findings"][0]["body"].as_str().unwrap().len(), 900, "findings are whole");
            assert_eq!(review["scope"]["notCovered"][0]["path"], "core/src/f15.rs");
            assert!(review.get("rawReport").is_none());
        }
        "submit a result" => {
            let receipt = &answers[0];
            assert!(receipt["task"]["result"]["id"].is_string() && receipt["message"]["id"].is_string());
            assert_eq!(receipt["task"]["result"]["dispatchId"].as_str(), Some(seeded.dispatch.as_str()));
        }
        _ => {
            let delivery = &answers[0]["current"]["delivery"];
            let pr = &delivery["pullRequests"][0];
            assert_eq!((pr["headSha"].as_str(), pr["ci"]["state"].clone()), (Some(seeded.head.as_str()), json!("success")));
            assert_eq!((pr["latestReview"]["forCurrentHead"].clone(), pr["latestReview"]["conclusion"].clone()),
                (json!(true), json!("changes_requested")));
            let main = delivery["ciSubscriptions"].as_array().unwrap().iter()
                .find(|c| c["watch"]["branch"] == "main" && c["watch"]["event"] == "push").expect("main/push watch");
            assert_eq!((main["latestRun"]["conclusion"].clone(), main["latestRun"]["headSha"].clone()),
                (json!("success"), json!("d".repeat(40))));
        }
    }
}
