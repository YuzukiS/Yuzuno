//! R-38 §2.6: whether a merged pull request is in the Core release the user
//! runs, by commit ancestry alone, never by a release's name, version or
//! milestone. The release is the running bundle's manifest (guide::release,
//! set at start from --install-dir): its full commit. Whether a PR's merge
//! commit is an ancestor of that commit is GitHub's compare of the two, kept
//! here per (repository, merge commit, installed commit). Reading only reads
//! what is kept: a request's page never reaches the network. Until a compare
//! is kept, and for a source build (no commit), it is unknown.
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

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
