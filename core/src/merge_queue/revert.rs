//! The one-step revert of a merge whose main push CI went red (YN-18 S2d-2).
//! A lead of the repository's Projects or the user asks for it
//! (`merge_revert`), or Core does on its own once the user turned automatic
//! reverts on; either way only while the user allows reverts for the
//! repository. Core builds the revert on its own branch
//! `queue/revert-{entry}` and opens a PR; the revert is then an entry of the
//! queue. It merges as a merge commit pinned to its head once CI on it is
//! green, or at once when it restores exactly the tree of the main before the
//! bad merge and that main's push CI was green. It needs no review round: Core
//! built it mechanically (the Lead's call, YN-18 decision 3). It is the only
//! entry that passes the main_red pause of the merge it reverts, and green CI
//! on main after it ends that pause.
use super::checks::{self, Check, Hold};
use super::remote::{array, pages, read, segment};
use super::writes::{self, Write};
use crate::workspace::Workspace;
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::sync::Arc;

fn short(sha: &str) -> &str {
    &sha[..12.min(sha.len())]
}

/// One check of a revert entry: the revert is built first if it is not yet,
/// then its gate is read. `Ok(())` means it may merge now.
pub(super) async fn check(ws: &Arc<Workspace>, entry: &Value) -> Result<(Value, Check<()>)> {
    let id = entry["id"].as_str().context("The entry has no id")?.to_owned();
    let attempt = entry["attempt"].as_i64().unwrap_or(0);
    let repository = entry["repositoryId"].as_i64().context("The entry has no repository id")?;
    let repo = entry["repository"].as_str().context("The entry has no repository")?.to_owned();
    let base = entry["baseBranch"].as_str().context("The entry has no base branch")?.to_owned();
    let bad = entry["revert"]["bad"].as_str().context("The revert names no merge commit")?.to_owned();
    let mut evidence = json!({"checkedAt":crate::model::now(),"revert":entry["revert"]});
    macro_rules! hold {
        ($decision:expr) => {
            match $decision {
                Ok(value) => value,
                Err(hold) => return Ok((evidence, Err(hold))),
            }
        };
    }
    let queue = ws.stored(move |s| s.merge_repository(repository)).await?;
    if queue["revert"] != true {
        return Ok((evidence, Err(Hold::Stop("revert_not_allowed", "The user turned reverts off for this repository; Core builds or merges no revert".into()))));
    }
    // A revert follows no landing policy of its own; it records the
    // repository's, so a policy change while it is checked is still noticed.
    evidence["policy"] = queue["policy"].clone();

    // The merge to revert, and the main before it.
    let reverted = read(ws, format!("repos/{repo}/git/commits/{bad}")).await?;
    let before = checks::parents(&reverted).first().map(|s| s.to_string()).context("The reverted merge commit has no parents")?;
    let before_commit = read(ws, format!("repos/{repo}/git/commits/{before}")).await?;
    let before_tree = checks::tree_of(&before_commit).context("The main before the merge has no tree")?.to_owned();
    let by_ref = read(ws, format!("repos/{repo}/git/ref/heads/{base}")).await?;
    let by_branch = read(ws, format!("repos/{repo}/branches/{}", segment(&base))).await?;
    let main = hold!(checks::main_agrees(by_ref["object"]["sha"].as_str().unwrap_or(""), by_branch["commit"]["sha"].as_str().unwrap_or("")));
    evidence["main"] = json!({"before":main,"reverted":bad,"beforeMerge":before,"beforeMergeTree":before_tree});
    let paused = &queue["paused"];
    if !paused.is_null() && !super::store::revert_passes(entry, paused) {
        return Ok((evidence, Err(Hold::Wait(format!(
            "The repository's merge queue is paused ({}) by another entry; the revert waits for the unpause",
            paused["reason"].as_str().unwrap_or("?")
        )))));
    }

    let mut b = entry["batch"].clone();
    if !b["pr"].is_u64() {
        let (built, made) = build(ws, &id, attempt, repository, &repo, &base, entry, &main, &bad, &before_tree).await?;
        evidence["batch"] = built.clone();
        hold!(made);
        b = built;
    }
    evidence["batch"] = b.clone();
    if b["main"] != main.as_str() {
        return Ok((evidence, Err(Hold::Stop("revert_outdated", format!(
            "Main moved to {} since Core built the revert on {}; ask for the revert again",
            short(&main), short(b["main"].as_str().unwrap_or("?"))
        )))));
    }
    let head = b["commit"].as_str().context("The revert has no head")?.to_owned();
    let tree = b["tree"].as_str().context("The revert has no tree")?.to_owned();
    let number = b["pr"].as_u64().context("The revert has no PR")?;
    let pr = read(ws, format!("repos/{repo}/pulls/{number}")).await?;
    if pr["merged"] == true || pr["state"] != "open" || pr["head"]["sha"] != head.as_str() || pr["head"]["ref"] != b["branch"] {
        return Ok((evidence, Err(Hold::Stop("batch_changed", format!("Core's revert PR #{number} is no longer open at its revert head {}", short(&head))))));
    }
    hold!(checks::conflicting(&pr));

    // At once when the revert restores exactly the main before the merge and
    // that main's push CI was green; else once CI on the revert PR is green.
    let fast = if main == bad && tree == before_tree {
        let runs = read(ws, format!("repos/{repo}/actions/runs?branch={}&event=push&head_sha={before}&per_page=20", segment(&base))).await?;
        array(&runs, "workflow_runs")
            .into_iter()
            .find(|r| r["name"] == checks::CI && r["head_sha"] == before.as_str() && r["status"] == "completed" && r["conclusion"] == "success")
    } else {
        None
    };
    evidence["gate"] = match fast {
        Some(run) => json!({"kind":"revert","tree":tree,"fastPath":{"main":before,"run":run["id"],"conclusion":run["conclusion"]}}),
        None => {
            let (runs, total, more) =
                pages(ws, format!("repos/{repo}/actions/runs?head_sha={head}&event=pull_request&per_page=100&page=1"), "workflow_runs").await?;
            hold!(checks::complete("workflow runs on the revert", runs.len(), total, more));
            let newest = hold!(checks::head_runs(&runs, &[]));
            json!({"kind":"revert","tree":tree,"runs":newest.iter().map(|r| json!({"workflow":r["name"],"run":r["id"],"attempt":r["run_attempt"],"conclusion":r["conclusion"]})).collect::<Vec<_>>()})
        }
    };
    evidence["wouldMerge"] = json!({"method":"merge","sha":head,"endpoint":format!("repos/{repo}/pulls/{number}/merge")});
    Ok((evidence, Ok(())))
}

/// Build the revert of merge commit `bad` on `main` (design note (d)),
/// resuming whatever an interrupted check already wrote; each step is
/// recorded before the next write, as `remote::build_batch` does.
/// - The revert commit: the tree of the main before the merge, on top of the
///   merge (`POST git/commits`, an object only).
/// - Core's branch `queue/revert-{entry}`: at that commit when main is still
///   the merge; otherwise at main, with the revert commit merged in (a
///   conflict stops with `revert_conflict`).
/// - Its PR, not a draft, whose number the entry then takes.
#[allow(clippy::too_many_arguments)]
async fn build(
    ws: &Arc<Workspace>,
    id: &str,
    attempt: i64,
    repository: i64,
    repo: &str,
    base: &str,
    entry: &Value,
    main: &str,
    bad: &str,
    before_tree: &str,
) -> Result<(Value, Check<()>)> {
    let branch = writes::revert_branch(id);
    let old = &entry["batch"];
    if old.is_object() && old["main"] != main {
        return Ok((old.clone(), Err(Hold::Stop("revert_outdated", format!(
            "Main moved to {} while Core built the revert on {}; ask for the revert again",
            short(main), short(old["main"].as_str().unwrap_or("?"))
        )))));
    }
    let mut b = if old.is_object() {
        old.clone()
    } else {
        json!({"kind":"revert","branch":branch,"main":main,"createdAt":crate::model::now(),"ref":false,"revertCommit":null,
            "commit":null,"tree":null,"pr":null,"closed":false,"deleted":false})
    };
    let save = |b: Value| {
        let id = id.to_owned();
        async move {
            ensure!(ws.stored(move |s| s.merge_batch(&id, attempt, b)).await?, "merge_moved_on: the entry was cancelled or retried meanwhile");
            Ok::<_, anyhow::Error>(())
        }
    };
    save(b.clone()).await?;
    let n = entry["revert"]["pr"].clone();
    if !b["revertCommit"].is_string() {
        let message = format!(
            "Revert #{n}: main CI red after its merge\n\nThis reverts merge commit {bad}, restoring the tree of the main before it. Yuzuno Core's merge queue made it (entry {id}) because main's push CI run {} on that merge was red.",
            entry["revert"]["run"]
        );
        let (code, answer) = writes::write(ws, repository, repo, Write::CreateCommit { tree: before_tree, parent: bad, message }).await?;
        ensure!(code == 201 && answer["sha"].is_string(), "GitHub answered {code} creating the revert commit: {}", answer["message"]);
        b["revertCommit"] = answer["sha"].clone();
        save(b.clone()).await?;
    }
    let revert_commit = b["revertCommit"].as_str().unwrap_or("").to_owned();
    if b["ref"] != true {
        // Recorded before the request, so a branch whose answer was lost is
        // still removed by the cleanup.
        b["ref"] = json!("pending");
        save(b.clone()).await?;
        let start = if main == bad { revert_commit.as_str() } else { main };
        let (code, answer) = writes::write(ws, repository, repo, Write::CreateBranch { branch: &branch, main: start }).await?;
        match code {
            201 => {}
            422 => {
                let at = read(ws, format!("repos/{repo}/git/ref/heads/{branch}")).await?;
                ensure!(at["object"]["sha"].is_string(), "GitHub refused to create {branch}: {}", answer["message"]);
            }
            _ => bail!("GitHub answered {code} creating {branch}: {}", answer["message"]),
        }
        b["ref"] = json!(true);
        save(b.clone()).await?;
    }
    if !b["commit"].is_string() {
        if main == bad {
            b["commit"] = json!(revert_commit);
            b["tree"] = json!(before_tree);
        } else {
            let at = read(ws, format!("repos/{repo}/git/ref/heads/{branch}")).await?["object"]["sha"].as_str().unwrap_or("").to_owned();
            let commit = if at != main {
                // An interrupted earlier check already merged the revert here.
                read(ws, format!("repos/{repo}/git/commits/{at}")).await?
            } else {
                let message = format!("{branch}: main {} + the revert of #{n} (merge queue)", short(main));
                let (code, answer) = writes::write(ws, repository, repo, Write::MergeIntoBranch { branch: &branch, head: &revert_commit, message }).await?;
                match code {
                    201 => answer,
                    409 => {
                        b["cleanup"] = json!("pending");
                        save(b.clone()).await?;
                        return Ok((b, Err(Hold::Stop("revert_conflict", format!(
                            "The revert of merge commit {} does not apply onto main {}, which has moved on since: {}; revert it by hand",
                            short(bad), short(main), answer["message"].as_str().unwrap_or("merge conflict")
                        )))));
                    }
                    204 => {
                        b["cleanup"] = json!("pending");
                        save(b.clone()).await?;
                        return Ok((b, Err(Hold::Stop("nothing_to_merge", format!("Main {} already holds the revert", short(main))))));
                    }
                    _ => bail!("GitHub answered {code} merging the revert into {branch}: {}", answer["message"]),
                }
            };
            if checks::parents(&commit) != [main, revert_commit.as_str()] {
                b["cleanup"] = json!("pending");
                save(b.clone()).await?;
                return Ok((b, Err(Hold::Stop("batch_changed", format!("{branch} holds {}, which is not main {} with the revert merged in", commit["sha"], short(main))))));
            }
            b["commit"] = commit["sha"].clone();
            b["tree"] = json!(checks::tree_of(&commit));
        }
        save(b.clone()).await?;
    }
    if !b["pr"].is_u64() {
        let title = format!("Revert #{n}: main CI red after its merge (merge queue)");
        let body = format!(
            "**A revert made by Yuzuno Core's merge queue.** Main's push CI run {} went red after #{n} merged as {bad}. This PR restores the tree of the main before that merge{}. Core merges it once CI on it is green, or at once when main is still that merge and the main before it had green CI. Entry {id}.",
            entry["revert"]["run"],
            if main == bad { "" } else { ", merged onto the current main" }
        );
        let (code, answer) = writes::write(ws, repository, repo, Write::OpenRevertPull { branch: &branch, base, title, body }).await?;
        let number = match code {
            201 => answer["number"].as_u64(),
            422 => {
                let owner = repo.split('/').next().unwrap_or("");
                let open = read(ws, format!("repos/{repo}/pulls?head={owner}:{}&state=open&per_page=5", segment(&branch))).await?;
                open.as_array().and_then(|l| l.first()).and_then(|p| p["number"].as_u64())
            }
            _ => None,
        };
        let number = number.with_context(|| format!("GitHub answered {code} opening the revert PR: {}", answer["message"]))?;
        b["pr"] = json!(number);
        save(b.clone()).await?;
        let (id, head) = (id.to_owned(), b["commit"].as_str().unwrap_or("").to_owned());
        ws.stored(move |s| s.merge_revert_opened(&id, attempt, number, &head)).await?;
    }
    Ok((b, Ok(())))
}
