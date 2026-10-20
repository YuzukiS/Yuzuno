//! Continuations over fixed Git objects with a controlled fake reviewer: the
//! test issues the tool calls a reviewer would make and gives its report,
//! through the same responses, receipts and checks Core uses. No model runs.
use super::*;
use crate::{
    github::client::Repository,
    pr_review::{continuation::Continue, reviewer},
    workspace::Workspace,
};
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

fn report(correctness: &str) -> Value {
    json!({"findings":[],"overall_correctness":correctness,"overall_explanation":"Fake reviewer","overall_confidence_score":0.8})
}

/// A completed parent round of base → head (a.rs changed; b.rs and c.rs
/// added, plus whatever `change` adds) whose fake reviewer read `read`.
async fn parent_round(change: impl FnOnce(&Path), read: &[&str], check_after: bool) -> (Lab, Value) {
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
    change(&repo);
    git(&repo, &["add", "."]);
    git(&repo, &["commit", "-qm", "head"]);
    let head = git(&repo, &["rev-parse", "HEAD"]);
    let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
    let task = ws.store.collaboration_call(None, "task_create", json!({"requestId":"create","title":"Deliver PR"})).unwrap()["task"]["id"]
        .as_str().unwrap().to_owned();
    ws.store.github_link_object(&task, &Repository { id: 7, full_name: "owner/repo".into() }, "pull", 1, json!({"baseSha":base,"headSha":head})).unwrap();
    let start: crate::pr_review::Start = serde_json::from_value(json!({"requestId":"r1","taskId":task,"linkId":"7:pull:1","baseSha":base,"headSha":head})).unwrap();
    let (mut run, _) = ws.store.create_pr_review(None, &start, "parent").unwrap();
    for (key, sha) in [("baseSha", &base), ("headSha", &head), ("mergeBaseSha", &base)] {
        run[key] = json!(sha);
    }
    let mut context = ContextStore::new(git::Git { path: repo.join(".git") });
    context.prepare(&mut run).await.unwrap();
    let directory = ws.data_dir.join("pr-reviews").join("parent");
    fs::create_dir_all(&directory).unwrap();
    for path in read {
        let page = context_response(&ws, &mut run, &directory, &mut context, "source_diff", json!({"path":path,"offset":0})).await.unwrap();
        assert!(page["error"].is_null() && page["nextOffset"].is_null(), "{page}");
    }
    if check_after {
        context.postflight(&mut run, std::time::Instant::now() + std::time::Duration::from_secs(600)).await;
    }
    run["actualHarness"] = json!("codex");
    run["actualModel"] = json!(crate::pr_review::MODEL);
    reviewer::complete_report(&report("unknown"), &mut run);
    reviewer::rescope(&mut run);
    run["ledger"]["operationMs"] = json!(120_000);
    run["ledger"]["calls"] = json!(run["contextReads"].as_array().unwrap().len());
    run["ledger"]["bytes"] = run["contextBytes"].clone();
    run["ledger"]["nativeCompletion"] = json!("confirmed");
    run["finishedAt"] = json!(crate::model::now());
    ws.store.save_pr_review(&run, Some("parent raw report")).unwrap();
    let parent = ws.store.pr_review_report(&task, "parent").unwrap();
    (Lab { _dir: dir, ws, task, repo, base, head }, parent)
}

/// The continuation as Core admits and prepares it, up to the moment its
/// reviewer would start; `edit` changes the child before preparation.
async fn child_round(lab: &Lab, parent: &Value, edit: impl FnOnce(&mut Value)) -> (Value, ContextStore, Result<String>) {
    let input = Continue {
        request_id: "c1".into(),
        task_id: lab.task.clone(),
        review_id: "parent".into(),
        base_sha: lab.base.clone(),
        head_sha: lab.head.clone(),
        acknowledge_unreviewable: None,
    };
    let (mut child, held, created) = lab.ws.store.create_pr_review_continuation(None, &input, "child").unwrap();
    assert!(created && held.is_some());
    // What source::collect resolves from GitHub for the same snapshot.
    for (key, sha) in [("baseSha", &lab.base), ("headSha", &lab.head), ("mergeBaseSha", &lab.base)] {
        child[key] = json!(sha);
    }
    let mut context = ContextStore::new(git::Git { path: lab.repo.join(".git") });
    context.prepare(&mut child).await.unwrap();
    edit(&mut child);
    let prepared = crate::pr_review::prepare_continuation(&lab.ws, parent, &mut child, &mut context).await;
    (child, context, prepared)
}

fn scoped<'a>(run: &'a Value, path: &str) -> &'a Value {
    run["scope"]["paths"].as_array().unwrap().iter().find(|p| p["path"] == path).unwrap()
}

#[tokio::test]
async fn a_continuation_reads_only_what_its_parent_left_and_keeps_the_parents_proofs() {
    let (lab, parent) = parent_round(|_| {}, &["a.rs"], true).await;
    assert_eq!(parent["contextIncomplete"], true);
    assert_eq!(parent["contextReads"][0]["responseSha256"].as_str().map(str::len), Some(64), "receipts carry their response's hash");
    let (mut child, mut context, prepared) = child_round(&lab, &parent, |_| {}).await;
    let prepared = prepared.unwrap();
    let evidence: Value = serde_json::from_str(&prepared).unwrap();
    // Before any read the ledger already counts the continuation's evidence.
    assert_eq!(child["contextBytes"].as_u64(), Some(prepared.len() as u64));
    // The reviewer is told what the parent covered and found, and what is left.
    assert_eq!(evidence["continuationOf"]["reviewId"], "parent");
    assert_eq!(evidence["alreadyCovered"], json!([{"path":"a.rs","evidenceKind":"complete_diff","byReview":"parent"}]));
    assert_eq!(evidence["targets"].as_array().unwrap().iter().map(|t| t["path"].clone()).collect::<Vec<_>>(), [json!("b.rs"), json!("c.rs")]);
    assert_eq!(evidence["budgets"]["maxCalls"], 159);
    assert!(context.bytes() >= serde_json::to_string(&evidence).unwrap().len(), "its own evidence counts as context bytes");
    assert!(reviewer::prompt(&serde_json::to_string(&evidence).unwrap()).contains("CONTINUATION"));
    // Before any read, the union already has the parent's proof of a.rs.
    assert_eq!((child["coverage"]["coveredFileCount"].as_u64(), child["coverage"]["inheritedCoveredCount"].as_u64()), (Some(1), Some(1)));
    let directory = lab.ws.data_dir.join("pr-reviews").join("child");
    fs::create_dir_all(&directory).unwrap();
    for path in ["b.rs", "c.rs"] {
        let page = context_response(&lab.ws, &mut child, &directory, &mut context, "source_diff", json!({"path":path,"offset":0})).await.unwrap();
        assert!(page["error"].is_null(), "{page}");
    }
    assert_eq!(child["contextIncomplete"], false);
    assert_eq!((child["coverage"]["coveredFileCount"].as_u64(), child["coverage"]["deliveredCompleteDiffs"].as_u64()), (Some(3), Some(2)));
    assert_eq!((child["coverage"]["fullAddedSourceCount"].as_u64(), child["coverage"]["inheritedCoveredCount"].as_u64()), (Some(0), Some(1)), "the parent's proof is neither its diff nor its source read");
    // Each covered path names the review whose reads proved it.
    assert_eq!(scoped(&child, "a.rs")["facts"][0], json!({"kind":"covered","evidenceKind":"complete_diff","byReview":"parent"}));
    assert_eq!(scoped(&child, "b.rs")["facts"][0]["byReview"], "child");
    assert_eq!(child["contextReads"].as_array().unwrap().len(), 2, "only its own reads are its receipts");
    // The pre-start check measured exactly what the reads then cost.
    let measured = context.measure(&mut child, "b.rs", usize::MAX).await.unwrap() + context.measure(&mut child, "c.rs", usize::MAX).await.unwrap();
    assert_eq!(child["contextBytes"].as_u64(), Some((prepared.len() + measured) as u64));
    assert!(measured > context.patches.values().map(String::len).sum::<usize>(), "page envelopes are counted, not only the raw diffs");
    child["actualHarness"] = json!("codex");
    reviewer::complete_report(&report("patch is correct"), &mut child);
    assert_eq!(child["conclusion"], "no_findings");
    assert!(crate::pr_review::policy::passes(&child));
    // The parent's record is as it was.
    let stored = lab.ws.store.pr_review_report(&lab.task, "parent").unwrap();
    assert_eq!((&stored["coverage"], &stored["scope"], &stored["conclusion"]), (&parent["coverage"], &parent["scope"], &parent["conclusion"]));
}

#[tokio::test]
async fn the_reserved_budget_is_what_the_parent_left_and_is_never_refilled() {
    let (lab, parent) = parent_round(|_| {}, &["a.rs"], true).await;
    // One call left of the parent's: the second target is out of budget.
    let (mut child, mut context, prepared) = child_round(&lab, &parent, |child| child["continuation"]["reservation"]["calls"] = json!(1)).await;
    prepared.unwrap();
    let directory = lab.ws.data_dir.join("pr-reviews").join("child");
    fs::create_dir_all(&directory).unwrap();
    let first = context_response(&lab.ws, &mut child, &directory, &mut context, "source_diff", json!({"path":"b.rs","offset":0})).await.unwrap();
    assert!(first["error"].is_null());
    let second = context_response(&lab.ws, &mut child, &directory, &mut context, "source_diff", json!({"path":"c.rs","offset":0})).await.unwrap();
    assert!(second["error"].as_str().unwrap().starts_with("Continuation budget exhausted (1 calls"), "{second}");
    assert_eq!((scoped(&child, "c.rs")["state"].as_str(), scoped(&child, "c.rs")["reason"].as_str()), (Some("budget_exhausted"), Some("context_exhausted")));
    child["actualHarness"] = json!("codex");
    reviewer::complete_report(&report("patch is correct"), &mut child);
    assert_eq!(child["conclusion"], "unknown");
    // Bytes the unread diffs can't fit start nothing.
    let (lab, parent) = parent_round(|_| {}, &["a.rs"], true).await;
    let (child, context, prepared) = child_round(&lab, &parent, |child| child["continuation"]["reservation"]["bytes"] = json!(500)).await;
    assert!(prepared.unwrap_err().to_string().contains("don't fit"));
    assert!(context.receipts.is_empty() && child["nativeStartedAt"].is_null());
}

#[tokio::test]
async fn a_changed_snapshot_or_receipt_starts_nothing() {
    let (lab, parent) = parent_round(|_| {}, &["a.rs"], true).await;
    let mut other = parent.clone();
    other["scope"]["paths"][1]["head"]["blobSha"] = json!("0".repeat(40));
    let (_, context, prepared) = child_round(&lab, &other, |_| {}).await;
    assert!(prepared.unwrap_err().to_string().contains("blobs or modes differ"));
    assert!(context.receipts.is_empty());
    for (key, value, says) in [
        ("mergeBaseSha", json!("1".repeat(40)), "mergeBaseSha differs"),
        ("policy", json!({"state":"valid","revision":"x","blobSha":"y"}), "scope policy differs"),
    ] {
        let (lab, parent) = parent_round(|_| {}, &["a.rs"], true).await;
        let mut other = parent.clone();
        if key == "policy" {
            other["scope"]["policy"] = value;
        } else {
            other[key] = value;
        }
        let (_, _, prepared) = child_round(&lab, &other, |_| {}).await;
        assert!(prepared.unwrap_err().to_string().contains(says), "{key}");
    }
    // A retained response that no longer has its recorded hash, or is gone.
    for tamper in ["edit", "remove"] {
        let (lab, parent) = parent_round(|_| {}, &["a.rs"], true).await;
        let file = lab.ws.data_dir.join("pr-reviews").join("parent").join("context-1.json");
        if tamper == "edit" {
            fs::write(&file, "{}").unwrap();
        } else {
            fs::remove_file(&file).unwrap();
        }
        let (_, context, prepared) = child_round(&lab, &parent, |_| {}).await;
        let error = prepared.unwrap_err().to_string();
        assert!(error.contains(if tamper == "edit" { "doesn't match its recorded hash" } else { "is missing" }), "{error}");
        assert!(context.receipts.is_empty());
    }
}

#[tokio::test]
async fn an_unread_path_core_can_not_deliver_as_text_is_refused_before_the_reviewer() {
    // The parent's check after its review didn't run, so the binary is only
    // known as unread; Core finds it before a continuation's model starts.
    let (lab, parent) = parent_round(|repo| fs::write(repo.join("tool.bin"), b"MZ\0binary").unwrap(), &["a.rs", "b.rs", "c.rs"], false).await;
    assert_eq!(scoped(&parent, "tool.bin")["state"], "not_read");
    let (_, context, prepared) = child_round(&lab, &parent, |_| {}).await;
    let error = prepared.unwrap_err().to_string();
    assert!(error.contains("tool.bin can't be delivered as text") && error.ends_with("nothing was started."), "{error}");
    assert!(context.receipts.is_empty());
}

#[tokio::test]
async fn a_parents_failed_read_stays_unresolved_until_the_continuation_covers_that_path() {
    let (lab, mut parent) = parent_round(|_| {}, &["a.rs", "c.rs"], true).await;
    // The parent's read of b.rs failed and was never resolved.
    let failure = json!({"receipt":3,"kind":"source_unavailable","tool":"source_diff","requested":{"path":"b.rs","offset":0},"resolved":false});
    parent["coverage"]["failedRequests"] = json!([failure]);
    let (mut child, mut context, prepared) = child_round(&lab, &parent, |_| {}).await;
    prepared.unwrap();
    assert_eq!(child["coverage"]["unresolvedRequests"], 1);
    assert_eq!(scoped(&child, "b.rs")["state"], "read_failed");
    assert_eq!(scoped(&child, "b.rs")["facts"][0]["requests"][0]["byReview"], "parent");
    let directory = lab.ws.data_dir.join("pr-reviews").join("child");
    fs::create_dir_all(&directory).unwrap();
    context_response(&lab.ws, &mut child, &directory, &mut context, "source_diff", json!({"path":"b.rs","offset":0})).await.unwrap();
    assert_eq!((child["coverage"]["unresolvedRequests"].as_u64(), child["contextIncomplete"].as_bool()), (Some(0), Some(false)));
    // Kept as the parent's, never marked resolved.
    let carried = &child["coverage"]["inheritedFailedRequests"][0];
    assert_eq!((&carried["resolved"], &carried["coveredByThisRun"], &carried["byReview"]), (&json!(false), &json!(true), &json!("parent")));
}
