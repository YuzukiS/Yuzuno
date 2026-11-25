//! R-38 §2.6: whether a merged pull request is in the Core release the user
//! runs, by commit ancestry alone, never by a release's name, version or
//! milestone. The release is the running bundle's manifest (guide::release,
//! set at start from --install-dir): its full commit. Whether a PR's merge
//! commit is an ancestor of that commit is GitHub's compare of the two, kept
//! here per (repository, merge commit, installed commit). Reading only reads
//! what is kept: a request's page never reaches the network. Until a compare
//! is kept, and for a source build (no commit), it is unknown.
//!
//! What is kept is filled in three places, each asking GitHub only about a
//! merged PR whose answer against the release is not kept yet: a refresh
//! that reads a PR merged (mod.rs `schedule`), github_refresh of a task for
//! its merged PRs, which a refresh no longer reads (YN-193), and once at
//! start for every merged PR linked to a task, since a new install changes
//! the release while a merged PR never changes. Answers against other
//! releases are dropped then.
use crate::workspace::Workspace;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::Arc;

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    // contained: 1 the merge commit is an ancestor of (or is) the installed
    // commit, 0 it is not, NULL the repository has no such installed commit.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS github_installed_commits(repo_id INTEGER NOT NULL,merge_sha TEXT NOT NULL,
         installed_sha TEXT NOT NULL,contained INTEGER,checked_at TEXT NOT NULL,PRIMARY KEY(repo_id,merge_sha,installed_sha));",
    )?;
    Ok(())
}

/// The release this Core runs, as its manifest names it. Normally the one the
/// user installed; the two differ only while an update is being applied.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Installed {
    pub release_id: String,
    pub version: String,
    /// The full commit it was built from, in lower case.
    pub git_sha: String,
}

impl Installed {
    /// The running release, when Core runs a managed release whose manifest
    /// names a full commit; None for a source build.
    pub(crate) fn current() -> Option<Installed> {
        of(&crate::guide::release())
    }

    pub(crate) fn json(&self) -> Value {
        json!({"releaseId":self.release_id,"version":self.version,"gitSha":self.git_sha})
    }
}

/// `guide::release()`'s value as an Installed: only a managed release with a full commit.
pub(crate) fn of(release: &Value) -> Option<Installed> {
    let sha = release["gitSha"].as_str().filter(|sha| sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit()))?;
    if release["managed"] != true {
        return None;
    }
    Some(Installed {
        release_id: release["releaseId"].as_str()?.to_owned(),
        version: release["version"].as_str().unwrap_or_default().to_owned(),
        git_sha: sha.to_ascii_lowercase(),
    })
}

/// What is kept of whether a merge commit is in the installed commit.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Containment {
    /// An ancestor of the installed commit, or that commit itself.
    In,
    /// Not an ancestor: merged after it, or on another line.
    NotIn,
    /// The repository has no such installed commit: the question does not apply to it.
    Elsewhere,
    /// No compare kept yet, no merge commit read, or no installed commit.
    Unknown,
}

impl Containment {
    /// As a request's PR shows it: true only for In; false only for NotIn; null otherwise.
    fn shown(self) -> Value {
        match self {
            Containment::In => json!(true),
            Containment::NotIn => json!(false),
            Containment::Elsewhere | Containment::Unknown => Value::Null,
        }
    }
}

/// What is kept of merge commit `merge` of repository `repo` against `installed`.
pub(crate) fn kept(db: &Connection, repo: i64, merge: Option<&str>, installed: Option<&Installed>) -> Result<Containment> {
    let (Some(merge), Some(installed)) = (merge.filter(|sha| !sha.is_empty()), installed) else { return Ok(Containment::Unknown) };
    let row: Option<Option<i64>> = db
        .query_row(
            "SELECT contained FROM github_installed_commits WHERE repo_id=?1 AND merge_sha=?2 AND installed_sha=?3",
            params![repo, merge.to_ascii_lowercase(), installed.git_sha],
            |r| r.get(0),
        )
        .optional()?;
    Ok(match row {
        None => Containment::Unknown,
        Some(None) => Containment::Elsewhere,
        Some(Some(0)) => Containment::NotIn,
        Some(Some(_)) => Containment::In,
    })
}

/// The pull requests task `task` (its internal id) links, by repository and
/// number, each as Core last read it: its number, title, URL, repository,
/// state (open, draft, closed or merged), when it merged where Core read it,
/// and `installed`: true only once its merge commit is kept as in
/// `installed`, false once kept as not, else null.
pub(crate) fn task_pulls(db: &Connection, task: &str, installed: Option<&Installed>) -> Result<Vec<Value>> {
    let mut pulls = vec![];
    for link in super::store::task_links(db, task)?.into_iter().filter(|link| link["kind"] == "pull") {
        let snapshot = &link["snapshot"];
        let merged = snapshot["state"] == "merged";
        let containment = if merged {
            kept(db, link["repositoryId"].as_i64().unwrap_or_default(), snapshot["mergeCommitSha"].as_str(), installed)?
        } else {
            Containment::Unknown
        };
        pulls.push(json!({
            "number":link["number"],"title":snapshot["title"],"url":link["url"],"repository":link["repository"],
            "state":snapshot["state"].as_str().unwrap_or("unknown"),
            "mergedAt":if merged { snapshot["mergedAt"].clone() } else { Value::Null },
            "installed":containment.shown(),
        }));
    }
    Ok(pulls)
}

/// How many pull requests linked to `project`'s tasks are merged and kept as
/// not in `installed`, each once; None when any merged one is not known yet
/// (no merge commit read, or no compare kept). One whose repository has no
/// such installed commit counts for neither.
pub(crate) fn merged_after(db: &Connection, project: &str, installed: &Installed) -> Result<Option<i64>> {
    let merged = db
        .prepare_cached(
            "SELECT DISTINCT o.id,o.repo_id,json_extract(o.data,'$.snapshot.mergeCommitSha') FROM project_tasks p
             JOIN github_task_links l ON l.task_id=p.task_id JOIN github_objects o ON o.id=l.object_id
             WHERE p.project_id=?1 AND o.kind='pull' AND json_extract(o.data,'$.snapshot.state')='merged'",
        )?
        .query_map([project], |r| Ok((r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut after = 0;
    for (repo, merge) in merged {
        match kept(db, repo, merge.as_deref(), Some(installed))? {
            Containment::Unknown => return Ok(None),
            Containment::NotIn => after += 1,
            Containment::In | Containment::Elsewhere => {}
        }
    }
    Ok(Some(after))
}

/// Keeps GitHub's answer for merge commit `merge` of repository `repo`
/// against the installed commit: Some(whether it is an ancestor), or None
/// when the repository has no such commit.
pub(crate) fn record(db: &Connection, repo: i64, merge: &str, installed: &str, contained: Option<bool>) -> Result<()> {
    db.execute(
        "INSERT INTO github_installed_commits(repo_id,merge_sha,installed_sha,contained,checked_at) VALUES(?1,?2,?3,?4,?5)
         ON CONFLICT(repo_id,merge_sha,installed_sha) DO UPDATE SET contained=excluded.contained,checked_at=excluded.checked_at",
        params![repo, merge.to_ascii_lowercase(), installed, contained, crate::model::now()],
    )?;
    Ok(())
}

/// Most merged PRs one pass asks GitHub about. Each takes one compare; one
/// whose merge commit Core never read takes the PR's read (three calls)
/// before it. A pass that stops short leaves the rest for the next one.
pub(crate) const PASS: usize = 100;

/// A merged PR whose answer against the release is not kept.
#[derive(Debug, PartialEq)]
pub(crate) struct Unknown {
    pub object: String,
    pub repo: i64,
    pub full_name: String,
    pub number: u64,
    /// Its merge commit, when Core read it.
    pub merge: Option<String>,
}

/// The merged PRs linked to a task (to the task with internal id `task`
/// only, when given) whose answer against `installed` is not kept, newest
/// number first, at most `limit`.
pub(crate) fn unknown(db: &Connection, installed: &Installed, task: Option<&str>, limit: usize) -> Result<Vec<Unknown>> {
    let rows = db
        .prepare_cached(
            "SELECT o.id,o.repo_id,json_extract(r.data,'$.fullName'),o.number,json_extract(o.data,'$.snapshot.mergeCommitSha')
             FROM github_objects o JOIN github_repositories r ON r.id=o.repo_id
             WHERE o.kind='pull' AND json_extract(o.data,'$.snapshot.state')='merged'
               AND EXISTS(SELECT 1 FROM github_task_links l WHERE l.object_id=o.id AND (?1 IS NULL OR l.task_id=?1))
               AND NOT EXISTS(SELECT 1 FROM github_installed_commits c WHERE c.repo_id=o.repo_id
                 AND c.merge_sha=lower(json_extract(o.data,'$.snapshot.mergeCommitSha')) AND c.installed_sha=?2)
             ORDER BY o.number DESC LIMIT ?3",
        )?
        .query_map(params![task, installed.git_sha, limit as i64], |r| {
            Ok(Unknown { object: r.get(0)?, repo: r.get(1)?, full_name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                number: r.get::<_, i64>(3)? as u64, merge: r.get(4)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().filter(|row| !row.full_name.is_empty()).collect())
}

/// Drops what was kept against any release but `installed`.
pub(crate) fn forget_others(db: &Connection, installed: &Installed) -> Result<usize> {
    Ok(db.execute("DELETE FROM github_installed_commits WHERE installed_sha<>?1", [&installed.git_sha])?)
}

fn rate_limited(error: &anyhow::Error) -> bool {
    error.to_string().starts_with("rate_limited")
}

/// Asks GitHub whether merge commit `merge` of `repo` (`full_name`) is in
/// `installed`, and keeps the answer. An error keeps nothing: the next pass
/// asks again.
pub(crate) async fn check(ws: &Workspace, repo: i64, full_name: &str, merge: &str, installed: &Installed) -> Result<()> {
    let contained = ws.github.client.contains(full_name, &installed.git_sha, merge).await?;
    let (merge, sha) = (merge.to_owned(), installed.git_sha.clone());
    ws.stored(move |store| {
        let db = store.db.write()?;
        record(&db, repo, &merge, &sha, contained)
    })
    .await
}

/// One pass over the merged PRs whose answer against the release this Core
/// runs is not kept (of the task with internal id `task` only, when given):
/// each PR's merge commit read first where Core never read it, then GitHub's
/// compare, one PR at a time within GitHub's read slots, at most PASS. It
/// stops at GitHub's rate limit or Core's update fence; another pass of the
/// same scope does not start while one runs. None for a source build.
pub(crate) async fn pass(ws: &Arc<Workspace>, task: Option<String>) -> Result<Option<usize>> {
    let Some(installed) = (ws.github.release)() else { return Ok(None) };
    let key = format!("installed:{}", task.as_deref().unwrap_or("*"));
    if !super::claim(ws, &key) {
        return Ok(Some(0));
    }
    let result = async {
        let scope = installed.clone();
        let pending = ws
            .stored(move |store| {
                let db = store.db.write()?;
                if task.is_none() {
                    forget_others(&db, &scope)?;
                }
                unknown(&db, &scope, task.as_deref(), PASS)
            })
            .await?;
        let mut asked = 0;
        for one in pending {
            let _slot = ws.github.slots.acquire().await?;
            let Ok(_permit) = ws.admission.enter_work() else { break };
            let merge = match one.merge {
                Some(merge) => merge,
                None => {
                    let repo = super::client::Repository { id: one.repo, full_name: one.full_name.clone() };
                    let read = ws.github.client.object(&repo, "pull", one.number).await;
                    let limited = read.as_ref().err().is_some_and(rate_limited);
                    let merge = read.as_ref().ok().and_then(|snapshot| snapshot["mergeCommitSha"].as_str().map(str::to_owned));
                    let object = one.object.clone();
                    ws.stored(move |store| store.github_refresh_object(&object, read.map(|snapshot| (repo, snapshot)).map_err(|e| e.to_string())))
                        .await?;
                    if limited {
                        return Ok((asked, true));
                    }
                    let Some(merge) = merge else { continue };
                    merge
                }
            };
            asked += 1;
            match check(ws, one.repo, &one.full_name, &merge, &installed).await {
                Err(error) if rate_limited(&error) => return Ok((asked, true)),
                _ => {}
            }
        }
        Ok::<_, anyhow::Error>((asked, false))
    }
    .await;
    super::release(ws, key, matches!(result, Ok((_, true))));
    if matches!(result, Ok((asked, _)) if asked > 0) {
        ws.changes.send(json!({"collaboration":true}));
    }
    result.map(|(asked, _)| Some(asked))
}

impl Workspace {
    /// At start, once the release this Core runs is known: one pass over every
    /// merged PR linked to a task (`pass`), after Core has settled. Nothing
    /// for a source build.
    pub fn start_installed_check(self: &Arc<Self>) {
        if (self.github.release)().is_none() {
            return;
        }
        let weak = Arc::downgrade(self);
        crate::runtime_diag::spawn("svc installed-check", async move {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            let Some(ws) = weak.upgrade() else { return };
            if let Err(error) = pass(&ws, None).await {
                eprintln!("Which merged PRs the installed release has: {error:#}");
            }
        });
    }
}
