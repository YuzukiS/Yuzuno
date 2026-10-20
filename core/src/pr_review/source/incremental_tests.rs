//! Incremental rounds over fixed Git objects with a controlled fake reviewer:
//! the test issues the tool calls a reviewer would make and gives its report,
//! through the same responses, receipts and checks Core uses. No model runs.
use super::*;
use crate::{github::client::Repository, pr_review::reviewer, workspace::Workspace};
use std::{fs, process::Command, sync::Arc};

fn git(dir: &Path, args: &[&str]) -> String {
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
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    String::from_utf8(result.stdout).unwrap().trim().into()
}

struct Lab {
    _dir: tempfile::TempDir,
    ws: Arc<Workspace>,
    task: String,
    repo: std::path::PathBuf,
    base: String,
    head: String,
}

/// A completed full round of base → head (a.rs changed; b.rs and c.rs
/// added) whose fake reviewer read every path and found a P1 in b.rs.
async fn earlier_round() -> (Lab, Value) {
    let dir = tempfile::tempdir().unwrap();
    let repo = dir.path().join("repo");
    fs::create_dir(&repo).unwrap();
    git(&repo, &["init", "-q"]);
    fs::write(repo.join("a.rs"), "fn a() {}\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "base"]);
    let base = git(&repo, &["rev-parse", "HEAD"]);
    fs::write(repo.join("a.rs"), "fn a() { b(); }\n").unwrap();
    fs::write(repo.join("b.rs"), "pub fn b() { c(); }\n").unwrap();
    fs::write(repo.join("c.rs"), "pub fn c() {}\n").unwrap();
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "head"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let task = ws.store.collaboration_call(None, "task_create", json!({"requestId":"create","title":"Deliver PR"})).unwrap()["task"]["id"]
        .as_str().unwrap().to_owned();
    ws.store.github_link_object(&task, &Repository { id: 7, full_name: "owner/repo".into() }, "pull", 1, json!({"baseSha":base,"headSha":head})).unwrap();
    let start: crate::pr_review::Start = serde_json::from_value(json!({"requestId":"r1","taskId":task,"linkId":"7:pull:1","baseSha":base,"headSha":head})).unwrap();
    let (mut run, _) = ws.store.create_pr_review(None, &start, "earlier").unwrap();
    for (key, sha) in [("baseSha", &base), ("headSha", &head), ("mergeBaseSha", &base)] {
        run[key] = json!(sha);
    }
    let mut context = ContextStore::new(git::Git { path: repo.join(".git") });
    context.prepare(&mut run).await.unwrap();
    let directory = ws.data_dir.join("pr-reviews").join("earlier");
    fs::create_dir_all(&directory).unwrap();
    for path in ["a.rs", "b.rs", "c.rs"] {
        let page = context_response(&ws, &mut run, &directory, &mut context, "source_diff", json!({"path":path,"offset":0})).await.unwrap();
        assert!(page["error"].is_null() && page["nextOffset"].is_null(), "{page}");
    }
    run["actualHarness"] = json!("codex");
    run["actualModel"] = json!(crate::pr_review::MODEL);
    let bug = json!({"title":"Bug","body":"b() calls c() unconditionally","priority":1,"code_location":{"absolute_file_path":"b.rs","line_range":{"start":1,"end":1}}});
    reviewer::complete_report(&json!({"findings":[bug],"overall_correctness":"patch is incorrect","overall_explanation":"b.rs is wrong","overall_confidence_score":0.8}), &mut run);
    assert_eq!(run["conclusion"], "changes_requested");
    run["ledger"]["operationMs"] = json!(120_000);
    run["ledger"]["calls"] = json!(run["contextReads"].as_array().unwrap().len());
    run["ledger"]["bytes"] = run["contextBytes"].clone();
    run["ledger"]["nativeCompletion"] = json!("confirmed");
    run["finishedAt"] = json!(crate::model::now());
    ws.store.save_pr_review(&run, Some("earlier raw report")).unwrap();
    let earlier = ws.store.pr_review_report(&task, "earlier").unwrap();
    (Lab { _dir: dir, ws, task, repo, base, head }, earlier)
}

/// A new head made by `change` on top of the reviewed one, committed.
fn push(lab: &Lab, change: impl FnOnce(&Path)) -> String {
    change(&lab.repo);
    git(&lab.repo, &["add", "-A"]);
    git(&lab.repo, &["commit", "-q", "--allow-empty", "-m", "next"]);
    git(&lab.repo, &["rev-parse", "HEAD"])
}

/// The incremental round as Core admits and prepares it, up to the moment
/// its reviewer would start.
async fn next_round(lab: &Lab, base: &str, head: &str, merge_base: &str) -> (Value, ContextStore, Result<String>) {
    let start: crate::pr_review::Start = serde_json::from_value(json!({"requestId":"r2","taskId":lab.task,"linkId":"7:pull:1","baseSha":base,"headSha":head,"previousReviewId":"earlier"})).unwrap();
    let (mut run, created) = lab.ws.store.create_pr_review(None, &start, "now").unwrap();
    assert!(created && run["kind"] == "incremental");
    // What source::collect resolves from GitHub for the new snapshot.
    for (key, sha) in [("baseSha", base), ("headSha", head), ("mergeBaseSha", merge_base)] {
        run[key] = json!(sha);
    }
    let mut context = ContextStore::new(git::Git { path: lab.repo.join(".git") });
    context.prepare(&mut run).await.unwrap();
    let collected = serde_json::to_string(&json!({"baseSha":base,"headSha":head,"mergeBaseSha":merge_base,"changes":context.changes(&run, 0).unwrap(),
        "coveragePolicyVersion":run["coveragePolicyVersion"],"knownOutsideScope":[],"budgets":{"maxCalls":MAX_CALLS}})).unwrap();
    context.bytes = collected.len();
    let prepared = crate::pr_review::prepare_incremental(&lab.ws, &mut run, &mut context, &collected).await;
    (run, context, prepared)
}

fn scoped<'a>(run: &'a Value, path: &str) -> &'a Value {
    run["scope"]["paths"].as_array().unwrap().iter().find(|p| p["path"] == path).unwrap()
}

#[tokio::test]
async fn only_paths_unchanged_since_the_earlier_head_carry_its_proofs_and_a_fix_is_shown_by_this_rounds_reads() {
    let (lab, earlier) = earlier_round().await;
    let next = push(&lab, |repo| fs::write(repo.join("b.rs"), "pub fn b() { if ready() { c(); } }\n").unwrap());
    let (mut run, mut context, prepared) = next_round(&lab, &lab.base, &next, &lab.base).await;
    let prepared = prepared.unwrap();
    assert_eq!(run["incremental"]["targets"], json!([{"path":"b.rs","status":"added","why":"changed","changedSinceEarlierHead":true}]));
    assert_eq!(run["incremental"]["carriedPaths"], json!(["a.rs", "c.rs"]));
    assert_eq!(run["incremental"]["sameMergeBase"], true);
    // a.rs and c.rs carry the earlier proofs, naming that round and its head.
    let proof = |path: &str| run["coverage"]["coveredFiles"].as_array().unwrap().iter().find(|c| c["path"] == path).cloned();
    assert_eq!(proof("a.rs").unwrap()["byReview"], "earlier");
    assert_eq!(proof("a.rs").unwrap()["provedAtRevision"], lab.head.as_str());
    assert_eq!(proof("a.rs").unwrap()["revision"], next.as_str());
    assert!(proof("b.rs").is_none(), "a changed path is read again");
    assert_eq!(run["coverage"]["inheritedCoveredCount"], 2);
    assert_eq!(scoped(&run, "b.rs")["state"], "not_read");
    // The reviewer is told what the earlier round found and what to read.
    let evidence: Value = serde_json::from_str(&prepared).unwrap();
    assert_eq!(evidence["incrementalOf"]["reviewId"], "earlier");
    assert_eq!(evidence["incrementalOf"]["findings"][0]["index"], 0);
    assert_eq!(evidence["targets"][0]["path"], "b.rs");
    assert_eq!(evidence["alreadyCovered"].as_array().unwrap().len(), 2);
    assert_eq!(evidence["budgets"]["maxCalls"], MAX_CALLS, "a new snapshot gets a normal budget");
    assert_eq!(context.bytes(), prepared.len(), "its own evidence counts as context bytes");
    assert!(reviewer::prompt(&prepared).contains("INCREMENTAL"));
    // The fake reviewer reads b.rs at the new head and marks the P1 fixed there.
    let directory = lab.ws.data_dir.join("pr-reviews").join("now");
    fs::create_dir_all(&directory).unwrap();
    let page = context_response(&lab.ws, &mut run, &directory, &mut context, "source_diff", json!({"path":"b.rs","offset":0})).await.unwrap();
    assert!(page["error"].is_null(), "{page}");
    assert_eq!(run["contextIncomplete"], false);
    assert_eq!(scoped(&run, "b.rs")["facts"][0]["byReview"], "now");
    assert_eq!(scoped(&run, "a.rs")["facts"][0]["byReview"], "earlier");
    run["actualHarness"] = json!("codex");
    reviewer::complete_report(&json!({"findings":[],"overall_correctness":"patch is correct","overall_explanation":"b() now checks ready()","overall_confidence_score":0.8,
        "previous_findings":[{"index":0,"disposition":"fixed","fix_paths":["b.rs"],"explanation":"b() calls c() only when ready()"}]}), &mut run);
    assert_eq!(run["conclusion"], "no_findings");
    assert_eq!(run["settledFindings"][0]["settlement"]["fixPaths"], json!(["b.rs"]));
    assert!(crate::pr_review::policy::passes(&run));
    // The earlier round's record is as it was.
    let stored = lab.ws.store.pr_review_report(&lab.task, "earlier").unwrap();
    assert_eq!((&stored["coverage"], &stored["findings"], &stored["conclusion"]), (&earlier["coverage"], &earlier["findings"], &earlier["conclusion"]));
}

#[tokio::test]
async fn a_new_merge_base_makes_every_path_a_target() {
    let (lab, _) = earlier_round().await;
    // main moves on (an unrelated file) and is merged into the PR branch.
    git(&lab.repo, &["checkout", "-q", &lab.base]);
    fs::write(lab.repo.join("z.rs"), "fn z() {}\n").unwrap();
    git(&lab.repo, &["add", "."]);
    git(&lab.repo, &["commit", "-qm", "main moves"]);
    let main = git(&lab.repo, &["rev-parse", "HEAD"]);
    git(&lab.repo, &["checkout", "-q", &lab.head]);
    git(&lab.repo, &["merge", "-q", "--no-edit", &main]);
    let merged = git(&lab.repo, &["rev-parse", "HEAD"]);
    let (run, _, prepared) = next_round(&lab, &main, &merged, &main).await;
    prepared.unwrap();
    assert_eq!(run["incremental"]["sameMergeBase"], false);
    assert_eq!(run["incremental"]["carriedPaths"], json!([]));
    // Every path is read again, but none of their objects changed since the
    // earlier head, so none can hold a fix.
    let targets = run["incremental"]["targets"].as_array().unwrap();
    assert_eq!(targets.len(), 3);
    assert!(targets.iter().all(|t| t["why"] == "merge_base_changed" && t["changedSinceEarlierHead"] == false), "{targets:?}");
    assert_eq!(run["coverage"]["coveredFileCount"], 0);
}

#[tokio::test]
async fn a_head_that_changes_nothing_or_a_changed_earlier_receipt_starts_nothing() {
    // An empty commit: same merge base, paths, blobs and modes.
    let (lab, _) = earlier_round().await;
    let empty = push(&lab, |_| {});
    let (_, context, prepared) = next_round(&lab, &lab.base, &empty, &lab.base).await;
    assert!(prepared.unwrap_err().to_string().contains("changes none of the PR's paths"));
    assert!(context.receipts.is_empty());
    // A retained earlier response that no longer has its recorded hash.
    let (lab, _) = earlier_round().await;
    fs::write(lab.ws.data_dir.join("pr-reviews").join("earlier").join("context-1.json"), "{}").unwrap();
    let next = push(&lab, |repo| fs::write(repo.join("b.rs"), "pub fn b() {}\n").unwrap());
    let (_, context, prepared) = next_round(&lab, &lab.base, &next, &lab.base).await;
    assert!(prepared.unwrap_err().to_string().contains("doesn't match its recorded hash"));
    assert!(context.receipts.is_empty());
}

#[tokio::test]
async fn a_path_that_left_the_pr_is_listed_and_its_findings_stay() {
    let (lab, _) = earlier_round().await;
    let next = push(&lab, |repo| {
        fs::remove_file(repo.join("b.rs")).unwrap();
        fs::write(repo.join("c.rs"), "pub fn c() { done(); }\n").unwrap();
    });
    let (mut run, _, prepared) = next_round(&lab, &lab.base, &next, &lab.base).await;
    prepared.unwrap();
    assert_eq!(run["incremental"]["leftThePr"], json!(["b.rs"]));
    assert_eq!(run["incremental"]["targets"], json!([{"path":"c.rs","status":"added","why":"changed","changedSinceEarlierHead":true}]));
    // Nothing this round read is where the finding was: it stays and blocks.
    run["actualHarness"] = json!("codex");
    run["contextIncomplete"] = json!(false);
    reviewer::complete_report(&json!({"findings":[],"overall_correctness":"patch is correct","overall_explanation":"b.rs is gone","overall_confidence_score":0.8,
        "previous_findings":[{"index":0,"disposition":"fixed","fix_paths":["b.rs"],"explanation":"b.rs left the PR"}]}), &mut run);
    assert_eq!(run["findings"][0]["disposition"]["state"], "still_valid");
    assert_eq!(run["conclusion"], "changes_requested");
}
