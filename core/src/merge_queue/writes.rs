//! The only GitHub writes the merge queue makes (design §2, write guards).
//! Each one runs only while the repository's switch is on, with the Core
//! host's gh login. The merge is a merge commit pinned to the released head,
//! never admin. No push is ever forced. Core creates, closes and deletes only
//! its own `queue/merge-{entry}` and `queue/revert-{entry}` branches and their
//! PRs. CI is never rerun: no write here can start, rerun or cancel a workflow.
//! A revert's own writes (its commit, branch and PR, YN-18 S2d-2) also need
//! the user's consent to reverts for the repository.
use crate::workspace::Workspace;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::sync::Arc;

/// The branch an entry's batch lives on; Core touches no other branch.
pub(super) fn branch(entry: &str) -> String {
    format!("queue/merge-{entry}")
}
/// The branch a revert entry's revert lives on (YN-18 S2d-2).
pub(super) fn revert_branch(entry: &str) -> String {
    format!("queue/revert-{entry}")
}
fn ours(branch: &str) -> Result<()> {
    let id = branch
        .strip_prefix("queue/merge-")
        .or_else(|| branch.strip_prefix("queue/revert-"))
        .context("merge_write_refused: not a merge queue branch")?;
    ensure!(
        uuid::Uuid::parse_str(id).is_ok(),
        "merge_write_refused: not a merge queue branch"
    );
    Ok(())
}

pub(super) enum Write<'a> {
    /// `POST git/refs`: the batch branch at main.
    CreateBranch { branch: &'a str, main: &'a str },
    /// `POST merges`: the released head merged into the batch branch.
    MergeIntoBranch { branch: &'a str, head: &'a str, message: String },
    /// `POST pulls`: the draft PR whose pull_request event runs CI on the batch.
    OpenBatchPull { branch: &'a str, base: &'a str, title: String, body: String },
    /// `PATCH pulls/{n}`: close Core's own batch PR.
    CloseBatchPull { number: u64 },
    /// `DELETE git/refs/heads/{branch}`: delete Core's own batch branch.
    DeleteBranch { branch: &'a str },
    /// `PUT pulls/{n}/merge`: the merge itself.
    Merge { number: u64, head: &'a str },
    /// `POST git/commits`: a revert's commit, the tree of the main before the
    /// bad merge on top of that merge (an object only; no ref moves).
    CreateCommit { tree: &'a str, parent: &'a str, message: String },
    /// `POST pulls`: the PR of Core's own revert branch, not a draft.
    OpenRevertPull { branch: &'a str, base: &'a str, title: String, body: String },
}

/// One write to `repo`, refused unless the user's switch for `repository` is
/// on at this moment. Answers GitHub's status and body; an uncertain outcome
/// is an error; for the merge it stops the entry with merge_unknown.
pub(super) async fn write(ws: &Arc<Workspace>, repository: i64, repo: &str, w: Write<'_>) -> Result<(u16, Value)> {
    let on = ws
        .stored(move |s| s.merge_repository(repository))
        .await
        .map_err(|e| anyhow::anyhow!("not_sent: the merge queue switch could not be read: {e:#}"))?["enabled"]
        == true;
    if !on {
        bail!("merge_queue_disabled: the merge queue is off for {repo}; Core writes nothing to GitHub until the user turns it on");
    }
    let reverting = match &w {
        Write::CreateCommit { .. } | Write::OpenRevertPull { .. } => true,
        Write::CreateBranch { branch, .. } | Write::MergeIntoBranch { branch, .. } => branch.starts_with("queue/revert-"),
        _ => false,
    };
    if reverting {
        let allowed = ws.stored(move |s| s.merge_repository(repository)).await?["revert"] == true;
        ensure!(allowed, "merge_revert_not_allowed: reverts are off for {repo}; the user turns them on in Projects → repositories");
    }
    let client = &ws.github.client;
    let deadline = if matches!(w, Write::Merge { .. }) { client.merge_deadline } else { client.deadline };
    let (method, endpoint, body) = match w {
        Write::CreateBranch { branch, main } => {
            ours(branch)?;
            ("POST", format!("repos/{repo}/git/refs"), Some(json!({"ref":format!("refs/heads/{branch}"),"sha":main})))
        }
        Write::MergeIntoBranch { branch, head, message } => {
            ours(branch)?;
            ("POST", format!("repos/{repo}/merges"), Some(json!({"base":branch,"head":head,"commit_message":message})))
        }
        Write::OpenBatchPull { branch, base, title, body } => {
            ours(branch)?;
            ("POST", format!("repos/{repo}/pulls"), Some(json!({"head":branch,"base":base,"title":title,"body":body,"draft":true})))
        }
        Write::CloseBatchPull { number } => ("PATCH", format!("repos/{repo}/pulls/{number}"), Some(json!({"state":"closed"}))),
        Write::DeleteBranch { branch } => {
            ours(branch)?;
            ("DELETE", format!("repos/{repo}/git/refs/heads/{branch}"), None)
        }
        Write::Merge { number, head } => (
            "PUT",
            format!("repos/{repo}/pulls/{number}/merge"),
            Some(json!({"merge_method":"merge","sha":head})),
        ),
        Write::CreateCommit { tree, parent, message } => (
            "POST",
            format!("repos/{repo}/git/commits"),
            Some(json!({"message":message,"tree":tree,"parents":[parent]})),
        ),
        Write::OpenRevertPull { branch, base, title, body } => {
            ensure!(branch.starts_with("queue/revert-"), "merge_write_refused: not a revert branch");
            ours(branch)?;
            ("POST", format!("repos/{repo}/pulls"), Some(json!({"head":branch,"base":base,"title":title,"body":body,"draft":false})))
        }
    };
    let _slot = ws.github.slots.acquire().await?;
    client.answered_write(method, &endpoint, body.as_ref(), deadline).await
}
