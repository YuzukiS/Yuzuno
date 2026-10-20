use super::*;
use std::{fs, process::Command};

fn command(dir: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_AUTHOR_NAME", "Fixture")
        .env("GIT_AUTHOR_EMAIL", "fixture@example.invalid")
        .env("GIT_COMMITTER_NAME", "Fixture")
        .env("GIT_COMMITTER_EMAIL", "fixture@example.invalid")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().into()
}
async fn fixture() -> (tempfile::TempDir, ContextStore, Value) {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    command(&work, &["init", "--quiet"]);
    // Real Git objects, >1 MB, tiny diff; no mock JSON blob identities.
    let text = "let stable = 1; // important_symbol and unchanged caller contract\n".repeat(40_000);
    fs::write(work.join("large.rs"), &text).unwrap();
    fs::write(
        work.join("caller.rs"),
        "fn caller() { important_symbol(); }\n",
    )
    .unwrap();
    fs::write(work.join("crlf.rs"), "first\r\n日本語\r\nlast").unwrap();
    fs::write(work.join("deleted.rs"), "old\n").unwrap();
    fs::write(work.join(".gitattributes"), "*.rs diff=hostile\n").unwrap();
    fs::write(work.join("binary.bin"), b"not\0text").unwrap();
    command(&work, &["add", "."]);
    command(&work, &["commit", "-qm", "base"]);
    let base = command(&work, &["rev-parse", "HEAD"]);
    fs::write(
        work.join("large.rs"),
        text.replacen("let stable = 1", "let stable = 2", 1),
    )
    .unwrap();
    fs::remove_file(work.join("deleted.rs")).unwrap();
    for n in 0..25 {
        fs::write(work.join(format!("added-{n:02}.rs")), "new\n").unwrap();
    }
    command(&work, &["add", "."]);
    command(&work, &["commit", "-qm", "head"]);
    let head = command(&work, &["rev-parse", "HEAD"]);
    let path = dir.path().join("objects.git");
    command(
        dir.path(),
        &[
            "clone",
            "--bare",
            "--quiet",
            work.to_str().unwrap(),
            path.to_str().unwrap(),
        ],
    );
    // Mutable author tree moves after capture, but reads remain object-addressed.
    fs::write(work.join("large.rs"), "uncommitted malicious replacement").unwrap();
    let mut context = ContextStore::new(git::Git { path });
    let mut run = json!({"repository":"fixture/local","headSha":head,"baseSha":base,"mergeBaseSha":base,"comparison":format!("{base}..{head}")});
    context.prepare(&mut run).await.unwrap();
    (dir, context, run)
}
fn range(path: &str, rev: &str, start: usize, end: usize) -> Value {
    json!({"path":path,"revision":rev,"startLine":start,"endLine":end})
}
async fn all_diffs(context: &mut ContextStore, run: &mut Value) {
    let files = run["files"].as_array().unwrap().clone();
    for f in files {
        let mut offset = 0;
        loop {
            let v = context
                .response(
                    run,
                    "source_diff",
                    json!({"path":f["path"],"offset":offset}),
                )
                .await;
            assert!(v["error"].is_null(), "{v}");
            if let Some(next) = v["nextOffset"].as_u64() {
                offset = next;
            } else {
                break;
            }
        }
    }
}
fn conclusion(run: &Value) -> Value {
    crate::pr_review::reviewer::normalize(
        &json!({"findings":[],"overall_correctness":"patch is correct","overall_explanation":"All diffs inspected","overall_confidence_score":0.9}),
        run,
    )
    .unwrap()["conclusion"]
        .clone()
}

async fn search_recovery_fixture(
    extra_prefix: bool,
    binary: bool,
) -> (tempfile::TempDir, ContextStore, Value) {
    let dir = tempfile::tempdir().unwrap();
    let work = dir.path().join("work");
    fs::create_dir_all(work.join("src")).unwrap();
    command(&work, &["init", "--quiet"]);
    fs::write(work.join("outside.rs"), "before\n").unwrap();
    for n in 0..11 {
        let lines = if n == 0 { 45 } else { 1 };
        fs::write(
            work.join(format!("src/{n:02}.rs")),
            "needle\n".repeat(lines),
        )
        .unwrap();
    }
    if extra_prefix {
        fs::create_dir(work.join("src-extra")).unwrap();
        fs::write(work.join("src-extra/extra.rs"), "needle\n").unwrap();
    }
    if binary {
        fs::write(work.join("src/zz.bin"), b"not\0text").unwrap();
    }
    command(&work, &["add", "."]);
    command(&work, &["commit", "-qm", "base"]);
    let base = command(&work, &["rev-parse", "HEAD"]);
    fs::write(work.join("outside.rs"), "after\n").unwrap();
    command(&work, &["commit", "-qam", "head"]);
    let head = command(&work, &["rev-parse", "HEAD"]);
    let path = dir.path().join("objects.git");
    command(
        dir.path(),
        &[
            "clone",
            "--bare",
            "--quiet",
            work.to_str().unwrap(),
            path.to_str().unwrap(),
        ],
    );
    let mut context = ContextStore::new(git::Git { path });
    let mut run =
        json!({"repository":"fixture/local","headSha":head,"baseSha":base,"mergeBaseSha":base});
    context.prepare(&mut run).await.unwrap();
    // No checkout is used by source_search, including recovery proofs.
    fs::create_dir_all(work.join("src-extra")).unwrap();
    fs::write(work.join("src-extra/uncommitted.rs"), "needle\n").unwrap();
    (dir, context, run)
}

fn search_input(revision: &str, prefix: &str, query: &str, cursor: &str) -> Value {
    json!({"revision":revision,"pathPrefix":prefix,"query":query,"cursor":cursor})
}

async fn unavailable_search(context: &mut ContextStore, run: &mut Value, input: Value) -> usize {
    // Deterministic source-availability fault, not a claim about the historical
    // ENOENT's cause. Restore the exact object store before any successful read.
    let parked = context.git.path.with_extension("unavailable");
    fs::rename(&context.git.path, &parked).unwrap();
    let failure = context.response(run, "source_search", input).await;
    fs::rename(parked, &context.git.path).unwrap();
    assert_eq!(failure["kind"], "source_unavailable", "{failure}");
    context.receipts.len()
}

async fn finish_search(
    context: &mut ContextStore,
    run: &mut Value,
    prefix: &str,
    mut cursor: Value,
) {
    while let Some(next) = cursor.as_str() {
        let page = context
            .response(
                run,
                "source_search",
                search_input("head", prefix, "needle", next),
            )
            .await;
        assert!(page["error"].is_null(), "{page}");
        cursor = page["nextCursor"].clone();
    }
}

#[tokio::test]
async fn source_search_equivalent_recovery_requires_a_complete_receipt_chain() {
    let (_dir, mut context, mut run) = search_recovery_fixture(false, false).await;
    all_diffs(&mut context, &mut run).await;
    let first = context
        .response(
            &mut run,
            "source_search",
            search_input("head", "src", "needle", "0:1"),
        )
        .await;
    let cursor = first["nextCursor"].as_str().unwrap();
    let original = search_input("head", "src", "needle", cursor);
    let failed_at = unavailable_search(&mut context, &mut run, original.clone()).await;
    let failed_receipt = context.receipts[failed_at - 1].clone();
    let (index, line) = arguments::search_cursor(cursor).unwrap();
    let equivalent = search_input("head", "src/", "needle", &format!("{index:04}:{line:04}"));
    let page = context
        .response(&mut run, "source_search", equivalent)
        .await;
    assert!(page["error"].is_null());
    assert!(page["nextCursor"].is_string());
    assert_eq!(run["coverage"]["unresolvedRequests"], 1);
    let recovery = &run["coverage"]["failedRequests"][0]["searchRecovery"];
    assert_eq!(recovery["startCursor"], json!([index, line]));
    assert_eq!(recovery["pathSet"]["pathCount"], 11);
    assert_eq!(recovery["pathSet"]["sha256"].as_str().unwrap().len(), 64);
    let receipts = recovery["successfulReceipts"].clone();
    // A valid terminal page with the right query/set cannot skip the gap.
    let end = context
        .tree(run["headSha"].as_str().unwrap())
        .await
        .unwrap()
        .len();
    let jumped = context
        .response(
            &mut run,
            "source_search",
            search_input("head", "src/", "needle", &format!("{end}:1")),
        )
        .await;
    assert!(jumped["nextCursor"].is_null());
    assert_eq!(
        run["coverage"]["failedRequests"][0]["searchRecovery"]["successfulReceipts"],
        receipts
    );
    assert_eq!(conclusion(&run), "unknown");
    finish_search(&mut context, &mut run, "src/", page["nextCursor"].clone()).await;
    let failure = &run["coverage"]["failedRequests"][0];
    assert_eq!(failure["requested"], original);
    assert_eq!(failure["resolved"], true);
    assert_eq!(failure["resolvedByReceipt"], context.receipts.len());
    assert!(failure["searchRecovery"]["nextCursor"].is_null());
    assert_eq!(context.receipts[failed_at - 1], failed_receipt);
    assert_eq!(conclusion(&run), "no_findings");
}

#[tokio::test]
async fn source_search_recovery_rejects_other_scope_and_keeps_unrelated_gaps() {
    let (_dir, mut context, mut run) = search_recovery_fixture(true, false).await;
    let original = search_input("head", "src", "needle", "0:1");
    unavailable_search(&mut context, &mut run, original.clone()).await;
    for input in [
        search_input("head", "src/", "needle", "0:1"), // src-extra is real in this tree.
        search_input("mergeBase", "src", "needle", "0:1"), // Same paths/blobs, different revision.
        search_input("head", "src", "different", "0:1"),
        search_input("head", "src", "needle", "1:1"),
    ] {
        let page = context.response(&mut run, "source_search", input).await;
        assert!(page["error"].is_null());
        assert!(run["coverage"]["failedRequests"][0]["searchRecovery"].is_null());
        assert_eq!(run["coverage"]["unresolvedRequests"], 1);
    }
    context
        .response(&mut run, "source_read", range("missing.rs", "head", 1, 1))
        .await;
    // Literal retries also have to deliver their full continuation chain.
    let first = context.response(&mut run, "source_search", original).await;
    assert_eq!(run["coverage"]["unresolvedRequests"], 2);
    finish_search(&mut context, &mut run, "src", first["nextCursor"].clone()).await;
    assert_eq!(run["coverage"]["failedRequests"][0]["resolved"], true);
    assert_eq!(run["coverage"]["unresolvedRequests"], 1);
    assert!(
        !run["coverage"]["uninspected"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(conclusion(&run), "unknown");
    all_diffs(&mut context, &mut run).await;
    assert!(
        run["coverage"]["uninspected"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    assert_eq!(conclusion(&run), "unknown"); // The missing source was not repaired.
}

#[tokio::test]
async fn source_search_recovery_keeps_skipped_sources_and_terminal_limits() {
    let (_dir, mut context, mut run) = search_recovery_fixture(false, true).await;
    all_diffs(&mut context, &mut run).await;
    let binary_index = context
        .tree(run["headSha"].as_str().unwrap())
        .await
        .unwrap()
        .iter()
        .position(|e| e.path == "src/zz.bin")
        .unwrap();
    let cursor = format!("{binary_index}:1");
    unavailable_search(
        &mut context,
        &mut run,
        search_input("head", "src", "needle", &cursor),
    )
    .await;
    let page = context
        .response(
            &mut run,
            "source_search",
            search_input("head", "src/", "needle", &cursor),
        )
        .await;
    assert_eq!(page["skipped"].as_array().unwrap().len(), 1);
    assert!(page["nextCursor"].is_null());
    assert_eq!(run["coverage"]["unresolvedRequests"], 1);
    assert!(run["coverage"]["failedRequests"][0]["searchRecovery"].is_null());

    let (_dir2, mut context, mut run) = search_recovery_fixture(false, false).await;
    all_diffs(&mut context, &mut run).await;
    unavailable_search(
        &mut context,
        &mut run,
        search_input("head", "src", "needle", "0:1"),
    )
    .await;
    context.bytes = MAX_CONTEXT - 1;
    let rejected = context
        .response(
            &mut run,
            "source_search",
            search_input("head", "src/", "needle", "0:1"),
        )
        .await;
    assert_eq!(rejected["kind"], "terminal_limit");
    assert!(run["coverage"]["failedRequests"][0]["searchRecovery"].is_null());
    assert_eq!(run["coverage"]["failedRequests"][0]["resolved"], false);
    assert!(run["coverage"]["terminalLimit"].is_string());
    assert_eq!(conclusion(&run), "unknown");
}

#[tokio::test]
async fn source_search_recovery_does_not_reinterpret_a_cursor_invalid_for_the_tree() {
    let (_dir, mut context, mut run) = search_recovery_fixture(false, false).await;
    context.trees.clear();
    // Tree access fails before the original request can validate its index.
    unavailable_search(
        &mut context,
        &mut run,
        search_input("head", "src", "needle", "999999:1"),
    )
    .await;
    finish_search(&mut context, &mut run, "src/", json!("0:1")).await;
    assert_eq!(run["coverage"]["unresolvedRequests"], 1);
    assert!(run["coverage"]["failedRequests"][0]["searchRecovery"].is_null());
}

#[tokio::test]
async fn large_blob_small_diff_is_reviewable_and_mutable_tree_is_ignored() {
    let (_dir, mut context, mut run) = fixture().await;
    assert_eq!(run["fileCount"], 27);
    let first = context.changes(&run, 0).unwrap();
    assert_eq!(first["files"].as_array().unwrap().len(), 20);
    assert_eq!(first["nextCursor"], 20);
    assert_eq!(conclusion(&run), "unknown");
    all_diffs(&mut context, &mut run).await;
    assert_eq!(conclusion(&run), "no_findings");
    let head = context
        .response(&mut run, "source_read", range("large.rs", "head", 1, 2))
        .await;
    let old = context
        .response(
            &mut run,
            "source_read",
            range("large.rs", "mergeBase", 1, 2),
        )
        .await;
    assert!(head["sourceBytes"].as_u64().unwrap() > 1_000_000);
    assert!(
        head["source"]
            .as_str()
            .unwrap()
            .starts_with("let stable = 2")
    );
    assert!(
        old["source"]
            .as_str()
            .unwrap()
            .starts_with("let stable = 1")
    );
    assert_ne!(head["blobSha"], old["blobSha"]);
    assert_ne!(head["revision"], old["revision"]);
    assert!(context.patches["large.rs"].len() < 2000);
    let deleted = run["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == "deleted.rs")
        .unwrap();
    assert_eq!(deleted["sourceRevision"], run["mergeBaseSha"]);
    assert_eq!(deleted["lines"], 1);
    let crlf = context
        .response(&mut run, "source_read", range("crlf.rs", "head", 2, 2))
        .await;
    assert_eq!(crlf["source"], "日本語\r\n");
    let caller = context.response(&mut run,"source_search",json!({"revision":"head","query":"important_symbol","pathPrefix":"caller","cursor":"0:1"})).await;
    assert_eq!(caller["matches"][0]["path"], "caller.rs");
    assert_eq!(caller["matches"][0]["line"], 1);
    assert_eq!(caller["revision"], run["headSha"]);
    assert!(caller["nextCursor"].is_null());
}

#[tokio::test]
async fn failed_501_line_request_recovers_only_from_complete_same_revision_path_coverage() {
    let (_dir, mut context, mut run) = fixture().await;
    all_diffs(&mut context, &mut run).await;
    let failed = context
        .response(
            &mut run,
            "source_read",
            range("large.rs", "head", 1300, 1800),
        )
        .await;
    assert!(failed["error"].is_string());
    assert_eq!(conclusion(&run), "unknown");
    context
        .response(
            &mut run,
            "source_read",
            range("large.rs", "head", 1300, 1799),
        )
        .await;
    assert_eq!(conclusion(&run), "unknown");
    context
        .response(
            &mut run,
            "source_read",
            range("large.rs", "mergeBase", 1800, 1800),
        )
        .await;
    context
        .response(&mut run, "source_read", range("caller.rs", "head", 1, 1))
        .await;
    assert_eq!(conclusion(&run), "unknown");
    context
        .response(
            &mut run,
            "source_read",
            range("large.rs", "head", 1800, 2299),
        )
        .await;
    assert_eq!(conclusion(&run), "no_findings");
    assert_eq!(run["coverage"]["failedRequests"][0]["resolved"], true);
    assert!(
        run["contextReads"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["error"].is_string())
    );
    context
        .response(&mut run, "source_read", range("missing.rs", "head", 1, 2))
        .await;
    context
        .response(&mut run, "source_read", range("caller.rs", "head", 1, 2))
        .await;
    assert_eq!(conclusion(&run), "unknown");
    assert_eq!(run["coverage"]["unresolvedRequests"], 1);
}

#[tokio::test]
async fn response_and_overall_budgets_do_not_record_undelivered_coverage() {
    let (_dir, mut context, mut run) = fixture().await;
    let path = "large.rs";
    let patch = "\\ ".repeat(40_000); // JSON escaping and multiple pages.
    context.patches.insert(path.into(), patch.clone());
    let first = context
        .response(&mut run, "source_diff", json!({"path":path,"offset":0}))
        .await;
    assert!(serde_json::to_vec(&first).unwrap().len() <= MAX_RESPONSE);
    let next = first["nextOffset"].as_u64().unwrap();
    assert!(
        !run["coverage"]["uninspected"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    context.bytes = MAX_CONTEXT - 1;
    let failed = context
        .response(&mut run, "source_diff", json!({"path":path,"offset":next}))
        .await;
    assert!(failed["error"].as_str().unwrap().contains("budget"));
    assert_eq!(context.delivered[path], vec![(0, next as usize)]);
    context.bytes = 0; // A terminal limit cannot be cleared by later bookkeeping.
    let still = context
        .response(&mut run, "source_read", range("caller.rs", "head", 1, 1))
        .await;
    assert!(still["error"].is_string());
    assert_eq!(conclusion(&run), "unknown");
}

#[tokio::test]
async fn many_paths_are_paged_without_entering_initial_context() {
    let (_dir, mut context, run) = fixture().await;
    let head = run["headSha"].as_str().unwrap().to_owned();
    // Path cache format is identical to verified ls-tree records; stress page
    // behavior independently of filesystem creation cost.
    context.trees.insert(
        head.clone(),
        (0..5000)
            .map(|n| Entry {
                path: format!("long_directory_name/{n:05}/source_file_with_a_long_name.rs"),
                blob: "a".repeat(40),
                mode: "100644".into(),
            })
            .collect(),
    );
    assert!(
        serde_json::to_vec(
            &context.trees[&head]
                .iter()
                .map(|e| &e.path)
                .collect::<Vec<_>>()
        )
        .unwrap()
        .len()
            > 150_000
    );
    let mut cursor = 0;
    let mut seen = 0;
    loop {
        let page = context
            .paths(
                &run,
                Paths {
                    revision: "head".into(),
                    query: "".into(),
                    cursor,
                },
            )
            .await
            .unwrap();
        seen += page["paths"].as_array().unwrap().len();
        assert!(serde_json::to_vec(&page).unwrap().len() < MAX_RESPONSE);
        if let Some(next) = page["nextCursor"].as_u64() {
            cursor = next as usize;
        } else {
            break;
        }
    }
    assert_eq!(seen, 5000);
    assert!(
        serde_json::to_string(&context.changes(&run, 0).unwrap())
            .unwrap()
            .len()
            < 15_000
    );
}

#[tokio::test]
async fn paths_revisions_and_non_regular_source_are_restricted() {
    let (_dir, mut context, mut run) = fixture().await;
    for path in [
        "../secret",
        "/absolute",
        "a/../b",
        "a//b",
        "a\\b",
        "",
        "./a",
    ] {
        assert!(path_check(path).is_err());
    }
    for request in [
        range("caller.rs", "main", 1, 1),
        range("caller.rs", "head", 0, 1),
        range("binary.bin", "head", 1, 1),
    ] {
        assert!(context.response(&mut run, "source_read", request).await["error"].is_string());
    }
    assert_eq!(run["coverage"]["failedRequests"][0]["resolved"], false); // an explicit wrong revision is not evidence from head
    assert_eq!(run["coverage"]["failedRequests"][2]["resolved"], false);
    assert_eq!(run["coverage"]["failedRequests"][2]["kind"], "unsupported_source"); // actual missing readable source
    let schema = context_tools();
    assert_eq!(schema.len(), 5);
    assert!(
        schema
            .iter()
            .all(|s| s["inputSchema"]["additionalProperties"] == false)
    );
    assert!(sha(&json!("main")).is_err());
}

#[tokio::test]
async fn search_defaults_only_the_initial_cursor_and_follows_explicit_pages() {
    let (_dir, mut context, mut run) = fixture().await;
    let input = json!({"revision":"head","query":"important_symbol","pathPrefix":"large.rs"});
    let first = context
        .response(&mut run, "source_search", input.clone())
        .await;
    assert!(first["error"].is_null(), "{first}");
    assert_eq!(first["matches"][0]["line"], 1);
    assert_eq!(first["matches"][19]["line"], 20);
    let mut explicit_input = input.clone();
    explicit_input["cursor"] = json!("0:1");
    let explicit = context
        .response(&mut run, "source_search", explicit_input)
        .await;
    assert_eq!(first, explicit);
    let mut next = input.clone();
    next["cursor"] = first["nextCursor"].clone();
    let second = context.response(&mut run, "source_search", next).await;
    assert_eq!(second["matches"][0]["line"], 21);
    assert_eq!(second["revision"], run["headSha"]);
    assert_eq!(run["contextReads"][0]["requested"], input);
    assert_eq!(run["coverage"]["unresolvedRequests"], 0);
    assert_eq!(conclusion(&run), "unknown"); // Search never grants diff coverage.
    let schema = context_tools()
        .into_iter()
        .find(|s| s["name"] == "source_search")
        .unwrap();
    assert_eq!(
        schema["inputSchema"]["properties"]["cursor"]["default"],
        "0:1"
    );
    let required = schema["inputSchema"]["required"].as_array().unwrap();
    assert!(!required.contains(&json!("cursor")));
    assert_eq!(required.len(), 3);
}

#[tokio::test]
async fn corrected_search_parameters_resolve_receipts_without_erasing_failures() {
    let (_dir, mut context, mut run) = fixture().await;
    all_diffs(&mut context, &mut run).await;
    for cursor in [json!("bad"), json!("0:0"), json!("999999:1"), Value::Null] {
        let failed_input = json!({"revision":"head","query":"important_symbol","pathPrefix":"caller","cursor":cursor});
        let failed = context
            .response(&mut run, "source_search", failed_input.clone())
            .await;
        assert_eq!(failed["kind"], "invalid_arguments", "{failed}");
        assert_eq!(conclusion(&run), "unknown");
        assert_eq!(failed["correction"]["maxIdenticalFailures"], 3);
        // A different revision, query or path prefix cannot discharge the request.
        for wrong in [
            json!({"revision":"mergeBase","query":"important_symbol","pathPrefix":"caller"}),
            json!({"revision":"head","query":"unrelated","pathPrefix":"caller"}),
            json!({"revision":"head","query":"important_symbol","pathPrefix":"large"}),
        ] {
            context.response(&mut run, "source_search", wrong).await;
            assert_eq!(run["coverage"]["unresolvedRequests"], 1);
        }
        let corrected = context
            .response(
                &mut run,
                "source_search",
                json!({"revision":"head","query":"important_symbol","pathPrefix":"caller"}),
            )
            .await;
        assert!(corrected["error"].is_null());
        assert_eq!(conclusion(&run), "no_findings");
        let failure = run["coverage"]["failedRequests"]
            .as_array()
            .unwrap()
            .last()
            .unwrap();
        assert_eq!(failure["requested"], failed_input);
        assert_eq!(failure["resolvedByReceipt"], context.receipts.len());
        let receipt = failure["receipt"].as_u64().unwrap() as usize;
        assert!(run["contextReads"][receipt - 1]["error"].is_string());
    }
}

#[tokio::test]
async fn missing_arguments_recover_only_after_a_matching_successful_request() {
    let (_dir, mut context, mut run) = fixture().await;
    all_diffs(&mut context, &mut run).await;
    for (tool, bad, good) in [
        ("review_changes", json!({}), json!({"cursor":0})),
        (
            "source_diff",
            json!({"path":"large.rs"}),
            json!({"path":"large.rs","offset":0}),
        ),
        (
            "source_paths",
            json!({"revision":"head","query":"caller"}),
            json!({"revision":"head","query":"caller","cursor":0}),
        ),
        (
            "source_search",
            json!({"revision":"head","pathPrefix":"caller","cursor":"0:1"}),
            json!({"revision":"head","pathPrefix":"caller","query":"important_symbol"}),
        ),
        (
            "source_read",
            json!({"path":"large.rs","revision":"head","startLine":1300}),
            range("large.rs", "head", 1300, 1302),
        ),
    ] {
        let failed = context.response(&mut run, tool, bad).await;
        assert_eq!(failed["kind"], "invalid_arguments", "{failed}");
        assert_eq!(conclusion(&run), "unknown");
        if tool == "source_read" {
            context
                .response(&mut run, tool, range("large.rs", "head", 1, 2))
                .await;
            assert_eq!(run["coverage"]["unresolvedRequests"], 1);
        }
        let result = context.response(&mut run, tool, good).await;
        assert!(result["error"].is_null(), "{result}");
        assert_eq!(conclusion(&run), "no_findings");
    }
    assert_eq!(
        run["coverage"]["failedRequests"].as_array().unwrap().len(),
        5
    );
}

#[tokio::test]
async fn identical_failed_calls_stop_early_and_cannot_be_cleared_by_correction() {
    let (_dir, mut context, mut run) = fixture().await;
    all_diffs(&mut context, &mut run).await;
    let calls = context.receipts.len();
    let bad = json!({"revision":"head","query":"symbol","pathPrefix":"","cursor":"bad"});
    for n in 1..=MAX_IDENTICAL_FAILURES {
        let result = context
            .response(&mut run, "source_search", bad.clone())
            .await;
        assert_eq!(result["correction"]["identicalFailures"], n);
        assert_eq!(context.repeated_failure_limit, n == MAX_IDENTICAL_FAILURES);
    }
    assert_eq!(context.receipts.len(), calls + 3);
    assert!(context.bytes < MAX_CONTEXT / 2);
    assert!(
        run["coverage"]["terminalLimit"]
            .as_str()
            .unwrap()
            .contains("Repeated source tool failure")
    );
    let result = context
        .response(
            &mut run,
            "source_search",
            json!({"revision":"head","query":"symbol","pathPrefix":""}),
        )
        .await;
    assert_eq!(result["kind"], "terminal_limit");
    assert_eq!(conclusion(&run), "unknown");
    assert_eq!(run["coverage"]["unresolvedRequests"], 4);
}

#[tokio::test]
async fn correcting_parameters_never_clears_missing_source_or_wrong_identity() {
    let (_dir, mut context, mut run) = fixture().await;
    all_diffs(&mut context, &mut run).await;
    for request in [
        range("missing.rs", "head", 1, 1),
        range("caller.rs", "main", 1, 1),
        json!({"path":"missing.rs","revision":"head","startLine":1}),
        json!({"path":"caller.rs","revision":"main","startLine":1}),
    ] {
        context.response(&mut run, "source_read", request).await;
    }
    context
        .response(&mut run, "source_read", range("caller.rs", "head", 1, 1))
        .await;
    assert_eq!(run["coverage"]["unresolvedRequests"], 4);
    assert_eq!(conclusion(&run), "unknown");
}

#[tokio::test]
async fn shared_harness_entry_stops_on_third_failure_after_persisting_its_receipt() {
    let (dir, mut context, fixed) = fixture().await;
    let ws = crate::workspace::Workspace::new(
        dir.path().join("workspace"),
        "/tmp".into(),
        "unused".into(),
    )
    .unwrap();
    let mut run = ws
        .stored(|s| {
            let task = s.collaboration_call(
                None,
                "task_create",
                json!({"requestId":"fixture","title":"Review fixture"}),
            )?["task"]["id"]
                .as_str()
                .unwrap()
                .to_owned();
            s.github_link_object(
                &task,
                &crate::github::client::Repository {
                    id: 7,
                    full_name: "fixture/local".into(),
                },
                "pull",
                1,
                json!({}),
            )?;
            let input = crate::pr_review::Start {
                task_id: task,
                link_id: "7:pull:1".into(),
                request_id: "repeat-fixture".into(),
                notify_agent_id: None,
                base_sha: None,
                head_sha: None,
                acknowledge_unreviewable: None,
                previous_review_id: None,
            };
            Ok(s.create_pr_review(None, &input, "repeat-fixture")?.0)
        })
        .await
        .unwrap();
    run.as_object_mut()
        .unwrap()
        .extend(fixed.as_object().unwrap().clone());
    let request = json!({"revision":"head","query":"symbol","pathPrefix":"","cursor":"bad"});
    for n in 1..=3 {
        let result = context_response(
            &ws,
            &mut run,
            dir.path(),
            &mut context,
            "source_search",
            request.clone(),
        )
        .await;
        if n < 3 {
            assert!(result.unwrap()["error"].is_string());
        } else {
            assert!(
                result
                    .unwrap_err()
                    .to_string()
                    .contains("Repeated source tool failure")
            );
        }
        let original: Value = serde_json::from_slice(
            &fs::read(dir.path().join(format!("context-{n}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(original["requested"], request);
        assert_eq!(original["correction"]["identicalFailures"], n);
    }
    let task = run["taskId"].as_str().unwrap().to_owned();
    let saved = ws
        .stored(move |s| s.pr_review_report(&task, "repeat-fixture"))
        .await
        .unwrap();
    assert_eq!(saved["contextReads"].as_array().unwrap().len(), 3);
    assert_eq!(saved["contextIncomplete"], true);
    assert!(saved["coverage"]["terminalLimit"].is_string());
}

#[tokio::test]
async fn parameter_failures_with_valid_ranges_recover_from_split_reads_of_one_source() {
    let (_dir, mut context, mut run) = fixture().await;
    all_diffs(&mut context, &mut run).await;
    for bad in [
        json!({"path":"large.rs","revision":"head","startLine":1,"endLine":1000,"extra":true}),
        json!({"path":"large.rs","startLine":1,"endLine":1000}),
    ] {
        let failed = context.response(&mut run, "source_read", bad.clone()).await;
        assert_eq!(failed["kind"], "invalid_arguments");
        context
            .response(&mut run, "source_read", range("large.rs", "head", 1, 500))
            .await;
        assert_eq!(conclusion(&run), "unknown");
        context
            .response(
                &mut run,
                "source_read",
                range("large.rs", "mergeBase", 501, 1000),
            )
            .await;
        context
            .response(&mut run, "source_read", range("caller.rs", "head", 1, 100))
            .await;
        assert_eq!(run["coverage"]["unresolvedRequests"], 1);
        context
            .response(
                &mut run,
                "source_read",
                range("large.rs", "head", 501, 1000),
            )
            .await;
        assert_eq!(conclusion(&run), "no_findings");
        let failure = run["coverage"]["failedRequests"]
            .as_array()
            .unwrap()
            .last()
            .unwrap();
        assert_eq!(failure["requested"], bad);
        assert_eq!(
            failure["recoverySource"],
            json!({"path":"large.rs","revision":run["headSha"]})
        );
        assert_eq!(failure["resolvedByReceipt"], context.receipts.len());
    }
}

#[tokio::test]
async fn compound_parameter_errors_do_not_freeze_unchecked_invalid_pagination() {
    let (_dir, mut context, mut run) = fixture().await;
    all_diffs(&mut context, &mut run).await;
    for (tool, bad, good) in [
        (
            "source_search",
            json!({"revision":"head","query":"","pathPrefix":"caller","cursor":"999999:1"}),
            json!({"revision":"head","query":"symbol","pathPrefix":"caller"}),
        ),
        (
            "source_search",
            json!({"revision":"head","query":"symbol","cursor":"999999:1"}),
            json!({"revision":"head","query":"symbol","pathPrefix":"caller"}),
        ),
        (
            "source_search",
            json!({"revision":"head","query":"symbol","pathPrefix":"caller","cursor":"999999:1","extra":true}),
            json!({"revision":"head","query":"symbol","pathPrefix":"caller"}),
        ),
        (
            "source_paths",
            json!({"revision":"head","cursor":999999}),
            json!({"revision":"head","query":"caller","cursor":0}),
        ),
        (
            "review_changes",
            json!({"cursor":999999,"extra":true}),
            json!({"cursor":0}),
        ),
        (
            "source_diff",
            json!({"offset":999999}),
            json!({"path":"large.rs","offset":0}),
        ),
        (
            "source_read",
            json!({"path":"large.rs","revision":"head","startLine":1000,"endLine":500,"extra":true}),
            range("large.rs", "head", 1000, 1100),
        ),
    ] {
        let failed = context.response(&mut run, tool, bad).await;
        assert_eq!(failed["kind"], "invalid_arguments", "{failed}");
        assert_eq!(conclusion(&run), "unknown");
        let result = context.response(&mut run, tool, good).await;
        assert!(result["error"].is_null(), "{result}");
        assert_eq!(
            conclusion(&run),
            "no_findings",
            "{tool}: {}",
            run["coverage"]["failedRequests"]
        );
    }
}

#[tokio::test]
async fn compound_correction_preserves_a_semantically_valid_continuation() {
    let (_dir, mut context, mut run) = fixture().await;
    all_diffs(&mut context, &mut run).await;
    let first = context
        .response(
            &mut run,
            "source_search",
            json!({"revision":"head","query":"symbol","pathPrefix":"large"}),
        )
        .await;
    let cursor = first["nextCursor"].clone();
    context
        .response(
            &mut run,
            "source_search",
            json!({"revision":"head","query":"","pathPrefix":"large","cursor":cursor}),
        )
        .await;
    context
        .response(
            &mut run,
            "source_search",
            json!({"revision":"head","query":"symbol","pathPrefix":"large"}),
        )
        .await;
    assert_eq!(run["coverage"]["unresolvedRequests"], 1);
    context
        .response(
            &mut run,
            "source_search",
            json!({"revision":"head","query":"symbol","pathPrefix":"large","cursor":cursor}),
        )
        .await;
    assert_eq!(conclusion(&run), "no_findings");
}

#[test]
fn coverage_unions_keep_holes_and_never_count_duplicate_reads_twice() {
    assert_eq!(
        missing(1, 11, &[(1, 4), (3, 5), (6, 8), (6, 8)]),
        vec![(5, 6), (8, 11)]
    );
    assert!(missing(1300, 1801, &[(1300, 1800), (1800, 2300)]).is_empty());
    assert_eq!(missing(1300, 1801, &[(1300, 1800)]), vec![(1800, 1801)]);
}

async fn added_coverage_fixture() -> (tempfile::TempDir, ContextStore, Value) {
    let dir = tempfile::tempdir().unwrap();
    command(dir.path(), &["init", "-q"]);
    fs::write(dir.path().join("modified.rs"), "before\n").unwrap();
    fs::write(dir.path().join("old-name.rs"), "renamed\n").unwrap();
    command(dir.path(), &["add", "."]);
    command(dir.path(), &["commit", "-qm", "base"]);
    let base = command(dir.path(), &["rev-parse", "HEAD"]);
    fs::write(dir.path().join("modified.rs"), "after\n").unwrap();
    fs::rename(dir.path().join("old-name.rs"), dir.path().join("new-name.rs")).unwrap();
    fs::write(dir.path().join("new.rs"), "日本語\r\n".repeat(600)).unwrap();
    fs::write(dir.path().join("empty.rs"), "").unwrap();
    command(dir.path(), &["add", "."]);
    command(dir.path(), &["update-index", "--chmod=+x", "new.rs"]);
    command(dir.path(), &["commit", "-qm", "head"]);
    let head = command(dir.path(), &["rev-parse", "HEAD"]);
    let mut context = ContextStore::new(git::Git { path: dir.path().join(".git") });
    let mut run = json!({"headSha":head,"baseSha":base,"mergeBaseSha":base,"coveragePolicyVersion":COVERAGE_VERSION});
    context.prepare(&mut run).await.unwrap();
    (dir, context, run)
}

fn uncovered(run: &Value, path: &str) -> bool {
    run["coverage"]["uninspected"].as_array().unwrap().iter().any(|f| f["path"] == path)
}

#[tokio::test]
async fn full_added_source_covers_real_git_text_but_does_not_count_as_diff() {
    let (_dir, mut context, mut run) = added_coverage_fixture().await;
    // Out-of-order ranges and duplicates do not conceal the middle hole.
    for (start, end) in [(301, 800), (1, 100), (1, 100)] {
        let response = context.response(&mut run, "source_read", range("new.rs", "head", start, end)).await;
        assert!(response["error"].is_null(), "{response}");
    }
    assert!(uncovered(&run, "new.rs"));
    let response = context.response(&mut run, "source_read", range("new.rs", "head", 101, 300)).await;
    assert_eq!(response["mode"], "100755");
    assert_eq!(response["change"]["status"], "added");
    assert_eq!(response["change"]["oldMode"], "000000");
    assert!(!uncovered(&run, "new.rs"));
    assert_eq!(run["coverage"]["coveredFileCount"], 1);
    assert_eq!(run["coverage"]["deliveredCompleteDiffs"], 0);
    let proof = &run["coverage"]["coveredFiles"][0];
    assert_eq!(proof["deliveredVia"], "source_read");
    assert_eq!(proof["evidenceKind"], "full_added_source");
    assert_eq!(proof["receipts"], json!([1, 2, 3, 4]));

    let empty = context.response(&mut run, "source_read", range("empty.rs", "head", 1, 1)).await;
    assert_eq!(empty["source"], "");
    assert_eq!(empty["totalLines"], 0);
    assert_eq!(empty["startLine"], 1);
    assert_eq!(empty["endLine"], 0);
    assert!(!uncovered(&run, "empty.rs"));
    context.response(&mut run, "source_read", range("new-name.rs", "head", 1, 1)).await;
    // The deletion side of the rename still needs its diff.
    assert!(uncovered(&run, "old-name.rs"));
    for path in ["modified.rs", "old-name.rs"] {
        let diff = context.response(&mut run, "source_diff", json!({"path":path,"offset":0})).await;
        assert!(diff["error"].is_null(), "{diff}");
    }
    assert_eq!(run["coverage"]["coveredFileCount"], 5);
    assert_eq!(run["coverage"]["deliveredCompleteDiffs"], 2);
    assert_eq!(run["coverage"]["fullAddedSourceCount"], 3);
    assert_eq!(conclusion(&run), "no_findings");
    // A later full diff replaces the selected proof, not the underlying reads.
    context.response(&mut run, "source_diff", json!({"path":"empty.rs","offset":0})).await;
    assert_eq!(run["coverage"]["coveredFileCount"], 5);
    assert_eq!(run["coverage"]["deliveredCompleteDiffs"], 3);
    assert_eq!(run["coverage"]["fullAddedSourceCount"], 2);
}

#[tokio::test]
async fn source_read_does_not_upgrade_legacy_reviews_or_cover_modified_files() {
    let (_dir, mut context, mut run) = added_coverage_fixture().await;
    context.response(&mut run, "source_read", range("modified.rs", "head", 1, 1)).await;
    context.response(&mut run, "source_read", range("modified.rs", "mergeBase", 1, 1)).await;
    assert!(uncovered(&run, "modified.rs"));
    assert_eq!(run["coverage"]["coveredFileCount"], 0);

    run.as_object_mut().unwrap().remove("coveragePolicyVersion");
    let read = context.response(&mut run, "source_read", range("empty.rs", "head", 1, 1)).await;
    assert!(read["error"].is_null());
    assert!(uncovered(&run, "empty.rs"));
    assert!(run["coverage"]["coveredFileCount"].is_null());
    assert!(run["coverage"]["version"].is_null());
    assert_eq!(run["coverage"]["deliveredCompleteDiffs"], 0);
    assert_eq!(conclusion(&run), "unknown");
}

#[tokio::test]
async fn added_source_counts_only_delivered_ranges_and_recovers_scoped_failures() {
    let (_dir, mut context, mut run) = added_coverage_fixture().await;
    let rejected = context.response(&mut run, "source_read", range("new.rs", "head", 1, 600)).await;
    assert!(rejected["error"].is_string());
    assert_eq!(run["coverage"]["unresolvedRequests"], 1);
    for (start, end) in [(301, 600), (1, 300)] {
        context.response(&mut run, "source_read", range("new.rs", "head", start, end)).await;
    }
    assert_eq!(run["coverage"]["unresolvedRequests"], 0);
    assert!(!uncovered(&run, "new.rs"));
    assert_eq!(run["coverage"]["coveredFiles"][0]["receipts"], json!([2, 3]));
    // No range from a response rejected by the total budget is delivered.
    context.bytes = MAX_CONTEXT - 1;
    let rejected = context.response(&mut run, "source_read", range("empty.rs", "head", 1, 1)).await;
    assert!(rejected["error"].is_string());
    assert!(uncovered(&run, "empty.rs"));
    assert_eq!(run["contextIncomplete"], true);
}

#[tokio::test]
async fn oversized_binary_and_special_added_sources_never_grant_read_coverage() {
    let (dir, _context, mut run) = added_coverage_fixture().await;
    fs::write(dir.path().join("oversized.txt"), "\"".repeat(MAX_RESPONSE)).unwrap();
    fs::write(dir.path().join("binary.bin"), b"not\0text").unwrap();
    fs::write(dir.path().join("non-utf8.txt"), [0xff]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("new.rs", dir.path().join("link.rs")).unwrap();
    command(dir.path(), &["add", "."]);
    command(dir.path(), &["commit", "-qm", "unsupported additions"]);
    run["headSha"] = json!(command(dir.path(), &["rev-parse", "HEAD"]));
    let mut context = ContextStore::new(git::Git { path: dir.path().join(".git") });
    context.prepare(&mut run).await.unwrap();
    let too_big = context.response(&mut run, "source_read", range("oversized.txt", "head", 1, 1)).await;
    assert!(too_big["error"].as_str().unwrap().contains("64 KB"));
    for path in ["binary.bin", "non-utf8.txt"] {
        let response = context.response(&mut run, "source_read", range(path, "head", 1, 1)).await;
        assert_eq!(response["kind"], "unsupported_source");
        assert!(uncovered(&run, path));
    }
    #[cfg(unix)]
    {
        let link = context.response(&mut run, "source_read", range("link.rs", "head", 1, 1)).await;
        assert_eq!(link["kind"], "unsupported_source");
    }
    assert!(uncovered(&run, "oversized.txt"));
    assert_eq!(run["coverage"]["coveredFileCount"], 0);
}

#[tokio::test]
#[ignore = "explicitly supplied fixed upstream source artifact; no network"]
async fn real_large_source_tiny_change() {
    let artifact = std::env::var("YUZUNO_REVIEW_REAL_SOURCE").unwrap();
    let original = fs::read(&artifact).unwrap();
    assert!(original.len() > 1_000_000);
    let dir = tempfile::tempdir().unwrap();
    command(dir.path(), &["init", "-q"]);
    fs::write(dir.path().join("upstream.h"), &original).unwrap();
    command(dir.path(), &["add", "upstream.h"]);
    command(dir.path(), &["commit", "-qm", "fixed upstream source"]);
    let base = command(dir.path(), &["rev-parse", "HEAD"]);
    let blob = command(dir.path(), &["rev-parse", "HEAD:upstream.h"]);
    assert_eq!(blob, "3088a4a13cb50b918dd190711ec2a84532a28200");
    let mut changed = original.clone();
    changed.extend_from_slice(b"\n// T73 controlled tiny change\n");
    fs::write(dir.path().join("upstream.h"), &changed).unwrap();
    command(dir.path(), &["commit", "-qam", "tiny change"]);
    let head = command(dir.path(), &["rev-parse", "HEAD"]);
    let mut context = ContextStore::new(git::Git {
        path: dir.path().join(".git"),
    });
    let mut run = json!({"baseSha":base,"mergeBaseSha":base,"headSha":head});
    context.prepare(&mut run).await.unwrap();
    all_diffs(&mut context, &mut run).await;
    let excerpt = context
        .response(
            &mut run,
            "source_read",
            range("upstream.h", "mergeBase", 1300, 1302),
        )
        .await;
    assert_eq!(excerpt["blobSha"], blob);
    assert_eq!(excerpt["sourceBytes"], 4_345_221);
    assert_eq!(excerpt["totalLines"], 41_664);
    assert_eq!(conclusion(&run), "no_findings");
    let receipt = json!({"upstreamBlob":blob,"originalBytes":original.len(),"diffBytes":context.patches["upstream.h"].len(),"range":excerpt,"run":run,"modelUsed":false});
    fs::write(
        Path::new(&artifact).with_file_name("real-source-test.json"),
        serde_json::to_vec_pretty(&receipt).unwrap(),
    )
    .unwrap();
}

#[tokio::test]
async fn source_process_output_and_cancellation_are_bounded() {
    let (dir, context, _run) = fixture().await;
    let result = tokio::time::timeout(
        std::time::Duration::from_secs(2),
        context.git.run(
            &[
                "cat-file",
                "blob",
                &command(&dir.path().join("work"), &["rev-parse", "HEAD:large.rs"]),
            ],
            10,
        ),
    )
    .await
    .expect("byte cap must fail immediately, not at the 45-second operation deadline");
    assert!(result.unwrap_err().to_string().contains("byte budget"));
    // A fixed test-only alias launches a descendant; production tool schemas
    // cannot select a command/alias. Cancellation must kill the entire group.
    let marker = dir.path().join("child-pid");
    let alias = format!(
        "alias.wait-fixture=!sleep 60 & echo $! > {}; wait",
        marker.display()
    );
    let aborted = tokio::time::timeout(
        std::time::Duration::from_millis(150),
        context.git.run(&["-c", &alias, "wait-fixture"], 100),
    )
    .await;
    assert!(aborted.is_err());
    let pid: i32 = fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
    #[cfg(target_os = "linux")]
    {
        // A killed descendant can briefly be a zombie awaiting init's reap.
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        let state = fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        if !state.is_empty() {
            let state = state.split(") ").nth(1).unwrap().chars().next().unwrap();
            assert!(
                matches!(state, 'Z' | 'X'),
                "source descendant still executing: {state}"
            );
        }
    }
}

#[tokio::test]
#[ignore = "explicit read-only network probe against fixed published Yuzuno commits"]
async fn fixed_github_object_transport() {
    let directory = tempfile::tempdir().unwrap();
    let base = "951f487fbc71122e5f48e37c7d14d8c9237f2684";
    let head = "8eac935a5a9a6536e33dbbf3ad43f8b6f013e19b";
    let client = Client::default();
    let comparison = client
        .comparison_identity("YuzukiS/Yuzuno", base, head)
        .await
        .unwrap();
    assert_eq!(comparison["base"], base);
    assert_eq!(comparison["mergeBase"], base);
    let git = git::Git::create(directory.path(), "YuzukiS/Yuzuno", &[base, head])
        .await
        .unwrap();
    assert!(!directory.path().join("core").exists()); // no checkout
    assert!(!git.path.join("hooks").exists()); // no template/hook discovery
    let mut context = ContextStore::new(git);
    let mut run = json!({"baseSha":base,"headSha":head,"mergeBaseSha":base});
    context.prepare(&mut run).await.unwrap();
    let request = range("core/src/pr_review/source.rs", "head", 1, 5);
    let response = context.response(&mut run, "source_read", request).await;
    assert!(response["error"].is_null(), "{response}");
    assert_eq!(response["revision"], head);
    assert!(response["source"].as_str().unwrap().contains("GitHub API"));
    let result = json!({"comparisonIdentity":comparison,"source":response,"manifest":run["files"],"modelUsed":false,"checkoutCreated":false});
    let path = std::env::var("YUZUNO_REVIEW_TRANSPORT_EVIDENCE").unwrap();
    fs::write(path, serde_json::to_vec_pretty(&result).unwrap()).unwrap();
}

#[tokio::test]
async fn escaped_diff_pages_fit_and_reconstruct_every_utf8_byte() {
    let (_dir, mut context, mut run) = fixture().await;
    let patch = format!("{}{}", "\u{0001}".repeat(25_000), "日本語🦀".repeat(1000));
    // NUL is excluded from text; other controls are supported UTF-8 and expand
    // to six JSON bytes. The old fixed 12,000-byte first page could never fit.
    context.patches.insert("large.rs".into(), patch.clone());
    let mut offset = 0;
    let mut reconstructed = String::new();
    let mut pages = 0;
    loop {
        let value = context
            .response(
                &mut run,
                "source_diff",
                json!({"path":"large.rs","offset":offset}),
            )
            .await;
        assert!(value["error"].is_null(), "{value}");
        assert!(serde_json::to_vec(&value).unwrap().len() <= MAX_RESPONSE);
        assert_eq!(value["offset"], offset);
        reconstructed.push_str(value["patch"].as_str().unwrap());
        pages += 1;
        if let Some(next) = value["nextOffset"].as_u64() {
            assert!(next > offset);
            offset = next;
        } else {
            break;
        }
    }
    assert!(pages > 3);
    assert_eq!(reconstructed, patch);
    assert!(missing(0, patch.len(), &context.delivered["large.rs"]).is_empty());
    assert_eq!(run["coverage"]["unresolvedRequests"], 0);
}

#[tokio::test]
async fn escaped_path_and_manifest_pages_continue_without_oversized_responses() {
    let (_dir, mut context, mut run) = fixture().await;
    let head = run["headSha"].as_str().unwrap().to_owned();
    let paths: Vec<_> = (0..45)
        .map(|n| format!("{n:02}{}", "\u{0002}".repeat(990)))
        .collect();
    context.trees.insert(
        head.clone(),
        paths
            .iter()
            .map(|path| Entry {
                path: path.clone(),
                blob: "a".repeat(40),
                mode: "100644".into(),
            })
            .collect(),
    );
    run["files"] = json!(
        paths
            .iter()
            .map(|path| json!({"path":path,"sourceRevision":head,"sourceBlob":"a".repeat(40)}))
            .collect::<Vec<_>>()
    );
    for manifest in [false, true] {
        let mut cursor = 0;
        let mut seen = Vec::new();
        loop {
            let page = if manifest {
                context.changes(&run, cursor).unwrap()
            } else {
                context
                    .paths(
                        &run,
                        Paths {
                            revision: "head".into(),
                            query: "".into(),
                            cursor,
                        },
                    )
                    .await
                    .unwrap()
            };
            assert!(serde_json::to_vec(&page).unwrap().len() <= MAX_RESPONSE);
            let entries = page[if manifest { "files" } else { "paths" }]
                .as_array()
                .unwrap();
            assert!(!entries.is_empty());
            seen.extend(
                entries
                    .iter()
                    .map(|v| v["path"].as_str().unwrap().to_owned()),
            );
            if let Some(next) = page["nextCursor"].as_u64() {
                assert!(next as usize > cursor);
                cursor = next as usize;
            } else {
                break;
            }
        }
        assert_eq!(seen, paths);
    }
}

async fn scope_fixture(change: impl FnOnce(&Path)) -> (tempfile::TempDir, ContextStore, Value) {
    let dir = tempfile::tempdir().unwrap();
    command(dir.path(), &["init", "-q"]);
    fs::write(dir.path().join("flip.dat"), b"was\0binary").unwrap();
    fs::write(dir.path().join("kept.rs"), "fn kept() {}\n").unwrap();
    command(dir.path(), &["add", "."]);
    command(dir.path(), &["commit", "-qm", "base"]);
    let base = command(dir.path(), &["rev-parse", "HEAD"]);
    change(dir.path());
    command(dir.path(), &["add", "."]);
    command(dir.path(), &["commit", "-qm", "head"]);
    let head = command(dir.path(), &["rev-parse", "HEAD"]);
    let mut context = ContextStore::new(git::Git { path: dir.path().join(".git") });
    let mut run = json!({"headSha":head,"baseSha":base,"mergeBaseSha":base,"coveragePolicyVersion":COVERAGE_VERSION});
    context.prepare(&mut run).await.unwrap();
    (dir, context, run)
}

fn scoped<'a>(run: &'a Value, path: &str) -> &'a Value {
    run["scope"]["paths"].as_array().unwrap().iter().find(|p| p["path"] == path).unwrap()
}

#[tokio::test]
async fn scope_names_unsupported_and_too_large_paths_before_any_request() {
    let (dir, _context, mut run) = scope_fixture(|dir| {
        fs::write(dir.join("helper.exe"), b"MZ\0\0binary helper").unwrap();
        fs::write(dir.join("latin1.txt"), [0x63, 0x61, 0x66, 0xe9]).unwrap();
        fs::write(dir.join("flip.dat"), "now text\n").unwrap();
        fs::write(dir.join("huge.txt"), "a line of generated text that keeps going\n".repeat(40_000)).unwrap();
        fs::write(dir.join("ok.rs"), "fn ok() {}\n").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink("ok.rs", dir.join("link.rs")).unwrap();
    })
    .await;
    // A gitlink: the submodule's commit is never fetched or followed.
    let commit = run["baseSha"].as_str().unwrap().to_owned();
    command(dir.path(), &["update-index", "--add", "--cacheinfo", &format!("160000,{commit},vendor/sub")]);
    command(dir.path(), &["commit", "-qm", "submodule"]);
    run["headSha"] = json!(command(dir.path(), &["rev-parse", "HEAD"]));
    let mut context = ContextStore::new(git::Git { path: dir.path().join(".git") });
    context.prepare(&mut run).await.unwrap();
    assert!(run["contextReads"].as_array().unwrap().is_empty(), "nothing was requested yet");
    // Before the review, only what tree metadata shows: no changed blob is
    // read, so content-dependent limits aren't known yet.
    assert_eq!((scoped(&run, "vendor/sub")["state"].as_str(), scoped(&run, "vendor/sub")["reason"].as_str()), (Some("unsupported"), Some("submodule")));
    assert_eq!(scoped(&run, "vendor/sub")["facts"][0]["found"], "before_review");
    #[cfg(unix)]
    assert_eq!((scoped(&run, "link.rs")["state"].as_str(), scoped(&run, "link.rs")["reason"].as_str()), (Some("unsupported"), Some("symlink")));
    for path in ["helper.exe", "latin1.txt", "flip.dat", "huge.txt"] {
        assert_eq!(scoped(&run, path)["state"], "not_read", "{path}");
    }
    assert!(context.patches.is_empty(), "no patch was built before the review");
    let known: Vec<_> = scope::permanent_gaps(&run["scope"]).iter().map(|g| g["path"].clone()).collect();
    assert_eq!(known.len(), if cfg!(unix) { 2 } else { 1 }, "the reviewer is told only what is known: {known:?}");
    // What the reviewer reads and what it runs into are Core's records.
    let page = context.response(&mut run, "source_diff", json!({"path":"ok.rs","offset":0})).await;
    assert!(page["error"].is_null(), "{page}");
    let refused = context.response(&mut run, "source_diff", json!({"path":"helper.exe","offset":0})).await;
    assert_eq!(refused["kind"], "unsupported_source");
    assert_eq!((scoped(&run, "helper.exe")["state"].as_str(), scoped(&run, "helper.exe")["facts"][0]["found"].as_str()), (Some("unsupported"), Some("during_review")));
    // After the review, Core checks what is left, within its own deadline.
    context.postflight(&mut run, std::time::Instant::now() + std::time::Duration::from_secs(600)).await;
    for (path, state, reason) in [
        ("helper.exe", "unsupported", "binary"),
        ("latin1.txt", "unsupported", "not_utf8"),
        ("flip.dat", "unsupported", "binary"), // only its old side is binary
        ("vendor/sub", "unsupported", "submodule"),
        ("huge.txt", "budget_exhausted", "diff_exceeds_context"),
    ] {
        let entry = scoped(&run, path);
        assert_eq!((entry["state"].as_str(), entry["reason"].as_str()), (Some(state), Some(reason)), "{path}: {entry}");
    }
    assert_eq!(scoped(&run, "helper.exe")["facts"][0]["found"], "after_review", "the side-less fact is replaced by the sided one");
    assert!(scoped(&run, "huge.txt")["facts"][0]["totalDiffBytes"].as_u64().unwrap() > MAX_CONTEXT as u64);
    // Each path keeps both sides' frozen blob and mode; an unsupported side
    // says which side, with its content's SHA-256 when it is a regular file.
    let manifest = run["files"].as_array().unwrap().iter().find(|f| f["path"] == "helper.exe").unwrap().clone();
    let entry = scoped(&run, "helper.exe");
    assert_eq!((&entry["head"]["blobSha"], &entry["head"]["mode"]), (&manifest["sourceBlob"], &manifest["modeAtHead"]));
    assert!(entry.get("mergeBase").is_none(), "an added path has no merge-base side");
    let flip = scoped(&run, "flip.dat");
    assert_eq!(flip["facts"].as_array().unwrap().iter().filter(|f| f["kind"] == "unsupported").count(), 1, "only its old side");
    assert_eq!((&flip["facts"][0]["side"], &flip["facts"][0]["blobSha"]), (&json!("mergeBase"), &flip["mergeBase"]["blobSha"]));
    assert_eq!(flip["facts"][0]["contentSha256"], format!("{:x}", Sha256::digest(b"was\0binary")));
    assert_eq!(flip["head"]["mode"], "100644");
    assert_eq!(run["scope"]["headSha"], run["headSha"]);
    assert_eq!(run["scope"]["mergeBaseSha"], run["mergeBaseSha"]);
    assert_eq!(run["scope"]["policy"]["state"], "absent");
    assert!(!context.patches.contains_key("huge.txt"), "measured patches are not kept in the diff cache");
    // Reading everything readable still leaves the review incomplete, for
    // these reasons, whatever the model concludes.
    assert_eq!(scoped(&run, "ok.rs")["state"], "covered");
    assert_eq!(scoped(&run, "ok.rs")["facts"][0]["evidenceKind"], "complete_diff");
    let unsupported = if cfg!(unix) { 5 } else { 4 };
    assert_eq!(run["scope"]["counts"], json!({"covered":1,"not_read":0,"read_failed":0,"budget_exhausted":1,"unsupported":unsupported,"excluded":0}));
    let verdict = crate::pr_review::reviewer::normalize(
        &json!({"findings":[],"overall_correctness":"patch is correct","overall_explanation":"Readable files inspected","overall_confidence_score":0.9}),
        &run,
    )
    .unwrap();
    assert_eq!(verdict["conclusion"], "unknown");
    assert_eq!(verdict["reasonCodes"], json!(["coverage_incomplete", "unsupported_source", "diff_too_large"]));
    assert!(verdict["scopeConclusion"].is_null(), "only policy exclusions get a within-scope verdict");
    let message = crate::pr_review::reviewer::incomplete(&run);
    assert!(message.starts_with("Review coverage is incomplete: 1 of "), "{message}");
    assert!(message.contains("another round of the same head can't be complete"), "{message}");
}

#[tokio::test]
async fn scope_states_follow_what_core_delivered_failed_or_ran_out_of() {
    let (_dir, mut context, mut run) = scope_fixture(|dir| {
        fs::write(dir.join("flip.dat"), b"still\0binary").unwrap();
        fs::write(dir.join("ok.rs"), "fn ok() {}\n").unwrap();
        fs::write(dir.join("pages.rs"), "// a long added file, several diff pages\n".repeat(1_000)).unwrap();
        fs::write(dir.join("other.rs"), "fn other() {}\n").unwrap();
        fs::write(dir.join("never.rs"), "fn never() {}\n").unwrap();
    })
    .await;
    let ok = context.response(&mut run, "source_diff", json!({"path":"ok.rs","offset":0})).await;
    assert!(ok["error"].is_null(), "{ok}");
    let first = context.response(&mut run, "source_diff", json!({"path":"pages.rs","offset":0})).await;
    assert!(first["nextOffset"].is_u64(), "{first}");
    let failed = context.response(&mut run, "source_read", range("other.rs", "head", 0, 1)).await;
    assert!(failed["error"].is_string());
    assert_eq!(scoped(&run, "ok.rs")["state"], "covered");
    assert_eq!(scoped(&run, "pages.rs")["state"], "not_read");
    assert!(!scoped(&run, "pages.rs")["facts"][0]["remainingByteRanges"].as_array().unwrap().is_empty());
    assert_eq!(scoped(&run, "other.rs")["state"], "read_failed");
    assert_eq!(scoped(&run, "other.rs")["facts"][0]["requests"], json!([{"receipt":3,"kind":"invalid_arguments","tool":"source_read"}]));
    assert_eq!(scoped(&run, "never.rs")["state"], "not_read");
    // A budget that runs out leaves what was incomplete budget_exhausted; a
    // path with an unresolved failure stays read_failed, keeping both facts.
    context.bytes = MAX_CONTEXT;
    let stopped = context.response(&mut run, "source_diff", json!({"path":"never.rs","offset":0})).await;
    assert!(stopped["error"].as_str().unwrap().contains("budget"), "{stopped}");
    // The check after the review runs even though the reviewer's budget ran out.
    context.postflight(&mut run, std::time::Instant::now() + std::time::Duration::from_secs(600)).await;
    for (path, state) in [("ok.rs", "covered"), ("pages.rs", "budget_exhausted"), ("never.rs", "budget_exhausted"), ("other.rs", "read_failed"), ("flip.dat", "unsupported")] {
        assert_eq!(scoped(&run, path)["state"], state, "{path}");
    }
    assert_eq!(scoped(&run, "never.rs")["reason"], "context_exhausted");
    let kinds: Vec<_> = scoped(&run, "other.rs")["facts"].as_array().unwrap().iter().map(|f| f["kind"].clone()).collect();
    assert_eq!(kinds, [json!("read_failed"), json!("budget_exhausted"), json!("not_read")]);
    assert_eq!(run["scope"]["counts"]["excluded"], 0, "nothing is excluded without an explicit policy");
}

#[tokio::test]
async fn the_check_after_the_review_stops_at_its_deadline_and_says_so() {
    let (_dir, mut context, mut run) = scope_fixture(|dir| {
        fs::write(dir.join("flip.dat"), b"still\0binary").unwrap();
    })
    .await;
    context.postflight(&mut run, std::time::Instant::now()).await;
    let flip = scoped(&run, "flip.dat");
    assert_eq!(flip["state"], "not_read", "nothing is guessed: {flip}");
    assert!(flip["facts"].as_array().unwrap().iter().any(|f| f["kind"] == "not_checked_after_review"), "{flip}");
    assert!(context.terminal.is_none(), "the check never sets the review's terminal limit");
}

#[tokio::test]
async fn a_large_file_with_a_small_diff_stays_reviewable_under_scope() {
    let (dir, _context, mut run) = fixture().await;
    run["coveragePolicyVersion"] = json!(COVERAGE_VERSION);
    let mut context = ContextStore::new(git::Git { path: dir.path().join("objects.git") });
    context.prepare(&mut run).await.unwrap();
    let large = scoped(&run, "large.rs");
    assert_eq!(large["state"], "not_read", "{large}");
    assert!(large["facts"].as_array().unwrap().iter().all(|f| f["kind"] == "not_read"), "{large}");
    let mut offset = 0;
    loop {
        let page = context.response(&mut run, "source_diff", json!({"path":"large.rs","offset":offset})).await;
        assert!(page["error"].is_null(), "{page}");
        match page["nextOffset"].as_u64() {
            Some(next) => offset = next,
            None => break,
        }
    }
    assert_eq!(scoped(&run, "large.rs")["state"], "covered");
}

/// A base whose scope policy is `policy`; the head changes the policy to
/// `head_policy` and adds the given files.
async fn policy_fixture(policy: Option<&str>, head_policy: Option<&str>) -> (tempfile::TempDir, ContextStore, Value) {
    let dir = tempfile::tempdir().unwrap();
    command(dir.path(), &["init", "-q"]);
    fs::write(dir.path().join("kept.rs"), "fn kept() {}\n").unwrap();
    if let Some(policy) = policy {
        fs::create_dir_all(dir.path().join(".yuzuno")).unwrap();
        fs::write(dir.path().join(".yuzuno/review-scope.json"), policy).unwrap();
    }
    command(dir.path(), &["add", "."]);
    command(dir.path(), &["commit", "-qm", "base"]);
    let base = command(dir.path(), &["rev-parse", "HEAD"]);
    fs::create_dir_all(dir.path().join("helper/bin")).unwrap();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    fs::write(dir.path().join("helper/bin/tool.exe"), b"MZ\0\0prebuilt").unwrap();
    fs::write(dir.path().join("helper/build.rs"), "fn build() {}\n").unwrap();
    fs::write(dir.path().join("src/new.rs"), "fn new() {}\n").unwrap();
    if let Some(head_policy) = head_policy {
        fs::create_dir_all(dir.path().join(".yuzuno")).unwrap();
        fs::write(dir.path().join(".yuzuno/review-scope.json"), head_policy).unwrap();
    }
    command(dir.path(), &["add", "."]);
    command(dir.path(), &["commit", "-qm", "head"]);
    let head = command(dir.path(), &["rev-parse", "HEAD"]);
    let mut context = ContextStore::new(git::Git { path: dir.path().join(".git") });
    let mut run = json!({"headSha":head,"baseSha":base,"mergeBaseSha":base,"coveragePolicyVersion":COVERAGE_VERSION});
    context.prepare(&mut run).await.unwrap();
    (dir, context, run)
}

fn reasons_for(run: &Value) -> Value {
    crate::pr_review::reviewer::normalize(
        &json!({"findings":[],"overall_correctness":"patch is correct","overall_explanation":"In scope inspected","overall_confidence_score":0.9}),
        run,
    )
    .unwrap()
}

#[tokio::test]
async fn the_base_policy_excludes_paths_and_a_head_can_not_exempt_itself() {
    let base = r#"{"version":1,"exclude":[{"path":"helper/bin/**","reason":"Prebuilt by the release job; see its provenance"}]}"#;
    let widened = r#"{"version":1,"exclude":[{"path":"helper/bin/**","reason":"x"},{"path":"src/**","reason":"skip me"}]}"#;
    let (_dir, mut context, mut run) = policy_fixture(Some(base), Some(widened)).await;
    let policy = &run["scope"]["policy"];
    assert_eq!((policy["state"].as_str(), policy["revision"].as_str()), (Some("valid"), run["baseSha"].as_str()));
    assert_eq!(policy["rules"], json!([{"path":"helper/bin/**","reason":"Prebuilt by the release job; see its provenance"}]));
    assert_eq!(policy["changedByThisPr"], true);
    let tool = scoped(&run, "helper/bin/tool.exe");
    assert_eq!(tool["state"], "excluded");
    assert_eq!(tool["facts"][0]["rule"], "helper/bin/**");
    assert!(scope::permanent_gaps(&run["scope"]).iter().any(|g| g["path"] == "helper/bin/tool.exe"), "the reviewer is told before it starts");
    // The head's widened policy applies to nothing in this PR, and the policy
    // file itself is always reviewed.
    for path in ["src/new.rs", ".yuzuno/review-scope.json", "helper/build.rs"] {
        assert_eq!(scoped(&run, path)["state"], "not_read", "{path}");
    }
    for path in ["src/new.rs", ".yuzuno/review-scope.json", "helper/build.rs"] {
        let page = context.response(&mut run, "source_diff", json!({"path":path,"offset":0})).await;
        assert!(page["error"].is_null(), "{page}");
    }
    context.postflight(&mut run, std::time::Instant::now() + std::time::Duration::from_secs(600)).await;
    let kinds: Vec<_> = scoped(&run, "helper/bin/tool.exe")["facts"].as_array().unwrap().iter().map(|f| f["kind"].clone()).collect();
    assert_eq!(kinds, [json!("excluded"), json!("unsupported"), json!("not_read")], "the unsupported fact is kept, never turned into the exclusion");
    // Excluded paths keep the review incomplete; the verdict within the
    // policy's scope is shown beside it, never instead of it.
    let verdict = reasons_for(&run);
    assert_eq!(verdict["conclusion"], "unknown");
    assert_eq!(verdict["reasonCodes"], json!(["coverage_incomplete", "scope_excluded"]));
    assert_eq!(verdict["scopeConclusion"], "no_findings");
    assert!(crate::pr_review::reviewer::incomplete(&run).contains("excluded or not, those paths stay unreviewed"));
}

#[tokio::test]
async fn without_a_valid_base_policy_the_full_scope_applies() {
    let (_dir, _context, run) = policy_fixture(None, Some(r#"{"version":1,"exclude":[{"path":"helper/**","reason":"added by the head"}]}"#)).await;
    assert_eq!(run["scope"]["policy"]["state"], "absent");
    assert_ne!(scoped(&run, "helper/bin/tool.exe")["state"], "excluded");
    assert_eq!(run["scope"]["counts"]["excluded"], 0);
    let rules = |rules: &str| format!(r#"{{"version":1,"exclude":[{rules}]}}"#);
    let many: Vec<_> = (0..51).map(|n| format!(r#"{{"path":"p{n}","reason":"r"}}"#)).collect();
    for (case, policy) in [
        ("climbs out", rules(r#"{"path":"../secret","reason":"r"}"#)),
        ("absolute", rules(r#"{"path":"/etc/passwd","reason":"r"}"#)),
        ("glob", rules(r#"{"path":"helper/*.exe","reason":"r"}"#)),
        ("everything", rules(r#"{"path":"**","reason":"r"}"#)),
        ("backslash", rules(r#"{"path":"helper\\bin\\**","reason":"r"}"#)),
        ("dot segment", rules(r#"{"path":"helper/./bin/**","reason":"r"}"#)),
        ("blank reason", rules(r#"{"path":"helper/bin/**","reason":"  "}"#)),
        ("duplicate", rules(r#"{"path":"helper/bin/**","reason":"r"},{"path":"helper/bin/**","reason":"r"}"#)),
        ("unknown field", r#"{"version":1,"exclude":[],"include":[]}"#.into()),
        ("version", r#"{"version":2,"exclude":[]}"#.into()),
        ("too many rules", rules(&many.join(","))),
        ("too large", format!(r#"{{"version":1,"exclude":[],"pad":"{}"}}"#, "x".repeat(9000))),
        ("not json", "exclude helper".into()),
    ] {
        let (_dir, _context, run) = policy_fixture(Some(&policy), None).await;
        let policy = &run["scope"]["policy"];
        assert_eq!(policy["state"], "invalid", "{case}: {policy}");
        assert!(policy["error"].is_string(), "{case}");
        assert_ne!(scoped(&run, "helper/bin/tool.exe")["state"], "excluded", "{case}: nothing is excluded");
        let verdict = reasons_for(&run);
        assert!(verdict["reasonCodes"].as_array().unwrap().contains(&json!("scope_policy_invalid")), "{case}");
    }
}

#[tokio::test]
async fn an_invalid_base_policy_never_blocks_a_review_that_covered_every_path() {
    let dir = tempfile::tempdir().unwrap();
    command(dir.path(), &["init", "-q"]);
    fs::create_dir_all(dir.path().join(".yuzuno")).unwrap();
    fs::write(dir.path().join(".yuzuno/review-scope.json"), "not a policy").unwrap();
    fs::write(dir.path().join("a.rs"), "fn a() {}\n").unwrap();
    command(dir.path(), &["add", "."]);
    command(dir.path(), &["commit", "-qm", "base"]);
    let base = command(dir.path(), &["rev-parse", "HEAD"]);
    fs::write(dir.path().join("a.rs"), "fn a() { b(); }\n").unwrap();
    // The PR also fixes the policy: it is reviewed like any other file.
    fs::write(dir.path().join(".yuzuno/review-scope.json"), r#"{"version":1,"exclude":[]}"#).unwrap();
    command(dir.path(), &["add", "."]);
    command(dir.path(), &["commit", "-qm", "head"]);
    let head = command(dir.path(), &["rev-parse", "HEAD"]);
    let mut context = ContextStore::new(git::Git { path: dir.path().join(".git") });
    let mut run = json!({"headSha":head,"baseSha":base,"mergeBaseSha":base,"coveragePolicyVersion":COVERAGE_VERSION});
    context.prepare(&mut run).await.unwrap();
    assert_eq!(run["scope"]["policy"]["state"], "invalid");
    for path in ["a.rs", ".yuzuno/review-scope.json"] {
        let page = context.response(&mut run, "source_diff", json!({"path":path,"offset":0})).await;
        assert!(page["error"].is_null(), "{page}");
    }
    let verdict = reasons_for(&run);
    assert_eq!((verdict["conclusion"].as_str(), &verdict["reasonCodes"]), (Some("no_findings"), &json!([])));
}

#[tokio::test]
async fn reviews_under_earlier_coverage_policies_report_no_scope() {
    let (_dir, _context, run) = fixture().await;
    assert!(run["scope"].is_null());
    let (_dir, mut context, mut run) = added_coverage_fixture().await;
    run.as_object_mut().unwrap().remove("scope");
    run["coveragePolicyVersion"] = json!(2);
    context.coverage(&mut run);
    assert!(run["scope"].is_null());
    assert_eq!(run["coverage"]["version"], 2);
    // Policy 2 keeps T-134's full added-source coverage and its counts.
    let empty = context.response(&mut run, "source_read", range("empty.rs", "head", 1, 1)).await;
    assert!(empty["error"].is_null(), "{empty}");
    assert_eq!((run["coverage"]["coveredFileCount"].as_u64(), run["coverage"]["fullAddedSourceCount"].as_u64()), (Some(1), Some(1)));
    assert!(run["scope"].is_null());
}

/// T-155: a caller that passes a branch tip as the PR's base learns both
/// commits, that no reviewer ran, and where the PR's own revision is.
#[test]
fn a_moved_or_mistaken_revision_names_both_commits_and_what_to_read() {
    let (base, head, main) = ("a".repeat(40), "b".repeat(40), "c".repeat(40));
    assert_eq!(moved_revision(None, None, &base, &head), None);
    assert_eq!(moved_revision(Some(&base), Some(&head), &base, &head), None);
    let wrong_base = moved_revision(Some(&main), Some(&head), &base, &head).unwrap();
    assert!(wrong_base.starts_with(&format!("The PR's base is {base}, not the requested baseSha {main}; no reviewer ran.")), "{wrong_base}");
    assert!(wrong_base.contains("snapshot.baseSha") && wrong_base.contains("github_links") && wrong_base.contains("omitting baseSha alone reviews your headSha"));
    let moved_head = moved_revision(None, Some(&main), &base, &head).unwrap();
    assert!(moved_head.starts_with(&format!("The PR's head is {head}, not the requested headSha {main}")), "{moved_head}");
}
