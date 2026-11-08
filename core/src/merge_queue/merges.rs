//! A released head the last review round did not read, when all it adds after
//! that round are merges of heads that need no review of their own (YN-33,
//! trial YN-26 finding 3): a stacked PR that merged the PR below it once that
//! one was reviewed or landed, or a PR that merged its base branch in.
//!
//! The proof walks from the released head back to the reviewed head. Every
//! commit on the way is a merge of exactly two parents whose first parent is
//! the commit before it; the other parent is already on the base branch, or is
//! the head of a passing review round of this repository whose base is on the
//! base branch. Core redoes each merge in a private object store (`git
//! merge-tree`, the review's own isolated store: no checkout, a disk budget,
//! removed afterwards) and admits the head only when every redone merge is
//! clean and its tree is exactly the merge commit's. A mismatch can only
//! refuse: a match means every line came from the two reviewed sides. It
//! writes nothing to GitHub.
use super::checks::{self, Check, Hold};
use super::remote;
use crate::{pr_review::source::git::Git, workspace::Workspace};
use anyhow::{Context, Result};
use serde_json::{Value, json};
use std::sync::Arc;

/// At most this many merge commits may follow the reviewed head.
pub(super) const MERGES: usize = 4;
/// What one `git merge-tree` may print: the tree, and for a conflict the
/// files in conflict.
const OUTPUT: usize = 64 * 1024;

fn short(sha: &str) -> &str {
    &sha[..12.min(sha.len())]
}
fn refuse<T>(detail: String) -> Result<Check<T>> {
    Ok(Err(Hold::Stop("review_not_passing", detail)))
}

/// The repository a release is for.
pub(super) struct Target<'a> {
    pub repo: &'a str,
    pub repository: i64,
    pub base: &'a str,
}

/// The proof that `head` is `reviewed` plus merges that need no review of
/// their own, or why it is not. Reads GitHub and the store; writes nothing.
pub(super) async fn prove(ws: &Arc<Workspace>, t: &Target<'_>, head: &str, reviewed: &str) -> Result<Check<Value>> {
    let main = remote::main_now(ws, t.repo, t.base).await?;
    // From the head back to the reviewed head, first parents only.
    let mut chain: Vec<(String, String, String, String)> = Vec::new();
    let mut at = head.to_owned();
    loop {
        if chain.len() == MERGES {
            return refuse(format!(
                "More than {MERGES} commits follow the last reviewed head {} on the way to the released head {}; at most {MERGES} merges may follow a review round",
                short(reviewed), short(head)
            ));
        }
        let commit = remote::read(ws, format!("repos/{}/git/commits/{at}", t.repo)).await?;
        let parents = checks::parents(&commit);
        let tree = checks::tree_of(&commit).context("A commit without a tree")?.to_owned();
        if parents.len() != 2 {
            return refuse(format!(
                "{} follows the last reviewed head {} but is not a merge of two parents (it has {}); only merges of reviewed heads may follow a review round",
                short(&at), short(reviewed), parents.len()
            ));
        }
        if parents[1] == reviewed {
            return refuse(format!(
                "Merge {} has the reviewed head {} as its second parent; the reviewed head must be the branch merged into (the first parent)",
                short(&at), short(reviewed)
            ));
        }
        chain.push((at.clone(), parents[0].to_owned(), parents[1].to_owned(), tree));
        if parents[0] == reviewed {
            break;
        }
        at = parents[0].to_owned();
    }
    chain.reverse();

    let mut merges = Vec::new();
    for (commit, first, other, tree) in &chain {
        let why = if remote::ancestor(ws, t.repo, other, &main).await? {
            json!({"kind":"onBase"})
        } else {
            let (repository, sha) = (t.repository, other.clone());
            let Some(round) = ws.stored(move |s| s.merge_reviewed_head(repository, &sha)).await? else {
                return refuse(format!(
                    "Merge {} brings in {}, which is neither on {} nor the head of a passing review round of this repository",
                    short(commit), short(other), t.base
                ));
            };
            let base = round["baseSha"].as_str().unwrap_or("");
            if base.is_empty() || !remote::ancestor(ws, t.repo, base, &main).await? {
                return refuse(format!(
                    "Merge {} brings in {}, the head of review round {}, but that round's base {} is not on {}: commits below it were read by no round",
                    short(commit), short(other), round["id"].as_str().unwrap_or("?"), if base.is_empty() { "(unknown)" } else { short(base) }, t.base
                ));
            }
            json!({"kind":"reviewed","round":round["id"],"link":round["linkId"],"base":base})
        };
        let base = remote::merge_base(ws, t.repo, first, other).await?;
        merges.push(json!({"commit":commit,"parents":[first,other],"mergedIn":other,"why":why,"mergeBase":base,"tree":tree}));
    }

    // Redo every merge in a private object store, removed when it drops.
    let mut commits: Vec<String> = Vec::new();
    for m in &merges {
        for sha in [&m["parents"][0], &m["parents"][1], &m["mergeBase"]] {
            let sha = sha.as_str().unwrap_or("").to_owned();
            if !commits.contains(&sha) {
                commits.push(sha);
            }
        }
    }
    let directory = tempfile::tempdir().context("A directory for redoing the merges")?;
    let commits: Vec<&str> = commits.iter().map(String::as_str).collect();
    let git = store(ws, directory.path(), t.repo, &commits).await?;
    for m in &mut merges {
        let (first, other, base) = (m["parents"][0].as_str().unwrap_or(""), m["parents"][1].as_str().unwrap_or(""), m["mergeBase"].as_str().unwrap_or(""));
        let base = format!("--merge-base={base}");
        let (code, out) = git
            .run_accepting(&["merge-tree", "--write-tree", "--no-messages", &base, first, other], OUTPUT, &[0, 1])
            .await
            .context("Core could not redo the merge in its own object store")?;
        let redone = String::from_utf8_lossy(&out).lines().next().unwrap_or("").trim().to_owned();
        let (commit, tree) = (m["commit"].as_str().unwrap_or(""), m["tree"].as_str().unwrap_or(""));
        if code == 1 {
            return refuse(format!(
                "Merging {} into {} has conflicts, so merge {} resolved them by hand, which no review round read",
                short(other), short(first), short(commit)
            ));
        }
        if redone != tree {
            return refuse(format!(
                "Merge {} has tree {}, but merging {} into {} gives {}: it changes more than the merge",
                short(commit), short(tree), short(other), short(first), short(&redone)
            ));
        }
        m["redone"] = json!(redone);
    }
    Ok(Ok(json!({"head":head,"reviewedHead":reviewed,"main":main,"merges":merges,"at":crate::model::now()})))
}

/// The private object store the merges are redone in: the review's shallow
/// blob:none store of these commits, fetched from GitHub; a test names a
/// local repository holding them instead.
async fn store(ws: &Arc<Workspace>, directory: &std::path::Path, repo: &str, commits: &[&str]) -> Result<Git> {
    #[cfg(test)]
    if let Some(path) = ws.merge_queue.objects.lock().unwrap().clone() {
        return Ok(Git { path });
    }
    let _ = ws;
    Git::create(directory, repo, commits).await
}
