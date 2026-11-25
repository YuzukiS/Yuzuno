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
//! its merged PRs, which a refresh no longer reads (YN-193), and from start,
//! in small batches until none is left, every merged PR linked to a task
//! (an open task's first), since a new install changes the release while a
//! merged PR never changes. Answers against other releases are dropped then.
//! The three share each answer and each question under way, and GitHub's
//! rate limit stops them all (the lead's bounds on YN-227, comment 12384).
//!
//! "Not in this repository" is kept only when GitHub says the repository,
//! which it shows, has no such installed commit (HTTP 422). A compare GitHub
//! answers not found, or a repository it does not show, stays unknown: such a
//! PR is asked again later, each time later than the last, never taken as
//! unrelated, so no count is given while it is unknown.
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
         installed_sha TEXT NOT NULL,contained INTEGER,checked_at TEXT NOT NULL,PRIMARY KEY(repo_id,merge_sha,installed_sha));
         CREATE TABLE IF NOT EXISTS github_installed_repos(repo_id INTEGER NOT NULL,installed_sha TEXT NOT NULL,
         has_commit INTEGER NOT NULL,checked_at TEXT NOT NULL,PRIMARY KEY(repo_id,installed_sha));
         CREATE TABLE IF NOT EXISTS github_installed_tries(object_id TEXT NOT NULL,installed_sha TEXT NOT NULL,
         tries INTEGER NOT NULL,next_at TEXT NOT NULL,PRIMARY KEY(object_id,installed_sha));",
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

/// Most merged PRs one batch asks GitHub about. Each takes at most one read
/// of the PR (its merge commit, where Core never read it) and one compare;
/// a repository's first takes one read of the installed commit there.
pub(crate) const BATCH: usize = 20;
/// Between two batches from start.
const BETWEEN: std::time::Duration = std::time::Duration::from_secs(60);
/// How long after a PR could not be told it is asked again: 5 minutes, doubling with each try, at most a day.
fn backoff(tries: i64) -> chrono::Duration {
    chrono::Duration::minutes((5_i64 << (tries.clamp(1, 10) - 1)).min(24 * 60))
}

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
/// only, when given) whose answer against `installed` is not kept and is not
/// waiting to be asked again, those of a task going on first, then the newest
/// number, at most `limit`.
pub(crate) fn unknown(db: &Connection, installed: &Installed, task: Option<&str>, limit: usize) -> Result<Vec<Unknown>> {
    let rows = db
        .prepare_cached(
            "SELECT o.id,o.repo_id,json_extract(r.data,'$.fullName'),o.number,json_extract(o.data,'$.snapshot.mergeCommitSha')
             FROM github_objects o JOIN github_repositories r ON r.id=o.repo_id
             WHERE o.kind='pull' AND json_extract(o.data,'$.snapshot.state')='merged'
               AND EXISTS(SELECT 1 FROM github_task_links l WHERE l.object_id=o.id AND (?1 IS NULL OR l.task_id=?1))
               AND NOT EXISTS(SELECT 1 FROM github_installed_commits c WHERE c.repo_id=o.repo_id
                 AND c.merge_sha=lower(json_extract(o.data,'$.snapshot.mergeCommitSha')) AND c.installed_sha=?2)
               AND NOT EXISTS(SELECT 1 FROM github_installed_tries t WHERE t.object_id=o.id AND t.installed_sha=?2 AND t.next_at>?4)
             ORDER BY EXISTS(SELECT 1 FROM github_task_links l JOIN collaboration_tasks k ON k.id=l.task_id WHERE l.object_id=o.id
                 AND json_extract(k.data,'$.status') NOT IN ('done','cancelled') AND json_extract(k.data,'$.archivedAt') IS NULL) DESC,
               o.number DESC LIMIT ?3",
        )?
        .query_map(params![task, installed.git_sha, limit as i64, crate::model::now()], |r| {
            Ok(Unknown { object: r.get(0)?, repo: r.get(1)?, full_name: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                number: r.get::<_, i64>(3)? as u64, merge: r.get(4)? })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows.into_iter().filter(|row| !row.full_name.is_empty()).collect())
}

/// Drops what was kept against any release but `installed`.
pub(crate) fn forget_others(db: &Connection, installed: &Installed) -> Result<usize> {
    let mut dropped = 0;
    for table in ["github_installed_commits", "github_installed_repos", "github_installed_tries"] {
        dropped += db.execute(&format!("DELETE FROM {table} WHERE installed_sha<>?1"), [&installed.git_sha])?;
    }
    Ok(dropped)
}

/// Whether repository `repo` has the installed commit, as kept: Some(true), Some(false) (GitHub showed the
/// repository and said it has no such commit), or None, not known.
fn has_commit(db: &Connection, repo: i64, installed: &str) -> Result<Option<bool>> {
    Ok(db
        .query_row("SELECT has_commit FROM github_installed_repos WHERE repo_id=?1 AND installed_sha=?2", params![repo, installed],
            |r| r.get::<_, i64>(0))
        .optional()?
        .map(|has| has != 0))
}

/// That PR `object` could not be told against `installed` this time: asked again after its backoff.
fn tried(db: &Connection, object: &str, installed: &str) -> Result<()> {
    let tries: i64 = db
        .query_row("SELECT tries FROM github_installed_tries WHERE object_id=?1 AND installed_sha=?2", params![object, installed], |r| r.get(0))
        .optional()?
        .unwrap_or(0)
        + 1;
    let next = (chrono::Utc::now() + backoff(tries)).to_rfc3339_opts(chrono::SecondsFormat::Micros, true);
    db.execute("INSERT INTO github_installed_tries(object_id,installed_sha,tries,next_at) VALUES(?1,?2,?3,?4)
        ON CONFLICT(object_id,installed_sha) DO UPDATE SET tries=excluded.tries,next_at=excluded.next_at",
        params![object, installed, tries, next])?;
    Ok(())
}

fn rate_limited(error: &anyhow::Error) -> bool {
    error.to_string().starts_with("rate_limited")
}

/// The key that holds every path while GitHub's rate limit cools down.
const LIMITED: &str = "installed:limited";

/// A claimed key of the GitHub reads' jobs, released when dropped: a check or a batch cancelled mid-flight (its
/// future dropped, as a deadline does) never leaves its key held busy (review 495d21bf).
struct Claim<'a> {
    ws: &'a Workspace,
    key: String,
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        super::release(self.ws, std::mem::take(&mut self.key), false);
    }
}

/// `check` on a task of its own, within GitHub's read slots and Core's update fence: what a refresh that read a PR
/// merged asks, outside that refresh and its deadline (review 495d21bf).
pub(crate) fn spawn_check(ws: &Arc<Workspace>, repo: i64, full_name: String, merge: String, installed: Installed) {
    let weak = Arc::downgrade(ws);
    tokio::spawn(async move {
        let Some(ws) = weak.upgrade() else { return };
        let Ok(_slot) = ws.github.slots.acquire().await else { return };
        let Ok(_permit) = ws.admission.enter_work() else { return };
        let _ = check(&ws, repo, &full_name, &merge, &installed).await;
    });
}

/// What one question about a merged PR came to.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Asked {
    /// An answer is kept: just now, or already.
    Kept,
    /// GitHub could not tell this time: asked again later.
    Unknown,
    /// The same question is under way elsewhere: its answer is that one's.
    Elsewhere,
    /// GitHub's rate limit, now or still cooling down: nothing was asked.
    Limited,
}

/// Asks GitHub whether merge commit `merge` of `repo` (`full_name`) is in
/// `installed`, and keeps the answer, shared by every path: an answer kept
/// is not asked again, a question under way is not asked twice, and while
/// the rate limit cools down nothing is asked. A repository's first question
/// reads the installed commit there; only GitHub's "no such commit" (422)
/// keeps the repository as without it, its PRs then kept as not applying.
pub(crate) async fn check(ws: &Workspace, repo: i64, full_name: &str, merge: &str, installed: &Installed) -> Result<Asked> {
    if super::cooling(ws, LIMITED) {
        return Ok(Asked::Limited);
    }
    let (merge, sha) = (merge.to_ascii_lowercase(), installed.git_sha.clone());
    let known = {
        let (merge, sha) = (merge.clone(), sha.clone());
        ws.stored(move |store| {
            let db = store.db.read()?;
            let release = Installed { git_sha: sha.clone(), release_id: String::new(), version: String::new() };
            Ok((kept(&db, repo, Some(&merge), Some(&release))?, has_commit(&db, repo, &sha)?))
        })
        .await?
    };
    if known.0 != Containment::Unknown {
        return Ok(Asked::Kept);
    }
    let key = format!("installed:{repo}:{merge}:{sha}");
    if !super::claim(ws, &key) {
        return Ok(Asked::Elsewhere);
    }
    let _claim = Claim { ws, key };
    let asked = async {
        let contained = match known.1 {
            Some(false) => None,
            Some(true) => match ws.github.client.contains(full_name, &sha, &merge).await {
                Ok(Some(contained)) => Some(contained),
                Ok(None) => return Ok(Asked::Unknown),
                Err(error) if rate_limited(&error) => return Ok(Asked::Limited),
                Err(_) => return Ok(Asked::Unknown),
            },
            None => {
                let has = match ws.github.client.commit_sha(full_name, &sha).await {
                    Ok((200, _)) => true,
                    Ok((422, _)) => false,
                    Ok((_, answer)) if answer.starts_with("rate_limited") => return Ok(Asked::Limited),
                    Err(error) if rate_limited(&error) => return Ok(Asked::Limited),
                    _ => return Ok(Asked::Unknown),
                };
                let at = crate::model::now();
                let commit = sha.clone();
                ws.stored(move |store| {
                    let db = store.db.write()?;
                    db.execute("INSERT OR REPLACE INTO github_installed_repos(repo_id,installed_sha,has_commit,checked_at) VALUES(?1,?2,?3,?4)",
                        params![repo, commit, has, at])?;
                    Ok(())
                })
                .await?;
                if !has {
                    None
                } else {
                    match ws.github.client.contains(full_name, &sha, &merge).await {
                        Ok(Some(contained)) => Some(contained),
                        Ok(None) => return Ok(Asked::Unknown),
                        Err(error) if rate_limited(&error) => return Ok(Asked::Limited),
                        Err(_) => return Ok(Asked::Unknown),
                    }
                }
            }
        };
        let (merge, sha) = (merge.clone(), sha.clone());
        ws.stored(move |store| {
            let db = store.db.write()?;
            record(&db, repo, &merge, &sha, contained)
        })
        .await?;
        Ok::<_, anyhow::Error>(Asked::Kept)
    }
    .await;
    if matches!(asked, Ok(Asked::Limited)) {
        super::release(ws, LIMITED.to_owned(), true);
    }
    asked
}

/// What one batch did: how many PRs it asked about, and whether more wait.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Batch {
    pub asked: usize,
    pub more: bool,
    pub limited: bool,
}

/// One batch over the merged PRs whose answer against the release this
/// Core runs is not kept (of the task with internal id `task` only, when
/// given), at most `size`: each PR's merge commit read first where Core
/// never read it (one read of the PR), then `check`. A PR that could not be
/// told waits its backoff. It stops at the rate limit or Core's update fence;
/// another batch of the same scope does not start while one runs. None for a
/// source build.
pub(crate) async fn pass(ws: &Arc<Workspace>, task: Option<String>, size: usize) -> Result<Option<Batch>> {
    let Some(installed) = (ws.github.release)() else { return Ok(None) };
    let key = format!("installed:pass:{}", task.as_deref().unwrap_or("*"));
    if !super::claim(ws, &key) {
        return Ok(Some(Batch { asked: 0, more: true, limited: false }));
    }
    let _claim = Claim { ws: &**ws, key };
    let result = async {
        let scope = installed.clone();
        let pending = ws
            .stored(move |store| {
                let db = store.db.write()?;
                if task.is_none() {
                    forget_others(&db, &scope)?;
                }
                unknown(&db, &scope, task.as_deref(), size + 1)
            })
            .await?;
        let more = pending.len() > size;
        let mut asked = 0;
        for one in pending.into_iter().take(size) {
            if super::cooling(ws, LIMITED) {
                return Ok(Batch { asked, more: true, limited: true });
            }
            let _slot = ws.github.slots.acquire().await?;
            let Ok(_permit) = ws.admission.enter_work() else { return Ok(Batch { asked, more: true, limited: false }) };
            asked += 1;
            let merge = match one.merge {
                Some(merge) => Some(merge),
                None => match ws.github.client.merge_commit(&one.full_name, one.number).await {
                    Ok(Some((merge, at))) => {
                        let (object, sha) = (one.object.clone(), merge.clone());
                        ws.stored(move |store| {
                            store.db.write()?.execute(
                                "UPDATE github_objects SET data=json_set(data,'$.snapshot.mergeCommitSha',?2,'$.snapshot.mergedAt',?3) WHERE id=?1",
                                params![object, sha, at])?;
                            Ok(())
                        })
                        .await?;
                        Some(merge)
                    }
                    Err(error) if rate_limited(&error) => {
                        super::release(ws, LIMITED.to_owned(), true);
                        return Ok(Batch { asked, more: true, limited: true });
                    }
                    _ => None,
                },
            };
            let outcome = match &merge {
                Some(merge) => check(ws, one.repo, &one.full_name, merge, &installed).await?,
                None => Asked::Unknown,
            };
            match outcome {
                Asked::Limited => return Ok(Batch { asked, more: true, limited: true }),
                Asked::Unknown => {
                    let (object, sha) = (one.object.clone(), installed.git_sha.clone());
                    ws.stored(move |store| {
                        let db = store.db.write()?;
                        tried(&db, &object, &sha)
                    })
                    .await?;
                }
                Asked::Kept | Asked::Elsewhere => {}
            }
        }
        Ok::<_, anyhow::Error>(Batch { asked, more, limited: false })
    }
    .await;
    if matches!(result, Ok(Batch { asked, .. }) if asked > 0) {
        ws.changes.send(json!({"collaboration":true}));
    }
    result.map(Some)
}

impl Workspace {
    /// From start, once the release this Core runs is known: batches over
    /// every merged PR linked to a task (`pass`), the first after Core has
    /// settled, then one a minute while more wait, five minutes after the
    /// rate limit; done once none is left but those waiting their backoff.
    /// Nothing for a source build.
    pub fn start_installed_check(self: &Arc<Self>) {
        if (self.github.release)().is_none() {
            return;
        }
        let weak = Arc::downgrade(self);
        crate::runtime_diag::spawn("svc installed-check", async move {
            let mut wait = std::time::Duration::from_secs(30);
            loop {
                tokio::time::sleep(wait).await;
                let Some(ws) = weak.upgrade() else { return };
                match pass(&ws, None, BATCH).await {
                    Ok(Some(batch)) if batch.more => wait = if batch.limited { std::time::Duration::from_secs(300) } else { BETWEEN },
                    Ok(_) => return,
                    Err(error) => return eprintln!("Which merged PRs the installed release has: {error:#}"),
                }
            }
        });
    }
}
