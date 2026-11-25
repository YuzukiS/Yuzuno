//! Link tables and bounded snapshots, separate from task goals/versions. All
//! calls run through Workspace::stored; no network IO under a database lock.
use super::client::Repository;
use crate::{model::now, store::Store};
use anyhow::{Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS github_repositories(id INTEGER PRIMARY KEY,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS github_project_repos(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,repo_id INTEGER NOT NULL REFERENCES github_repositories(id),PRIMARY KEY(project_id,repo_id));
      CREATE TABLE IF NOT EXISTS github_objects(id TEXT PRIMARY KEY,repo_id INTEGER NOT NULL REFERENCES github_repositories(id),kind TEXT NOT NULL,number INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(repo_id,kind,number));
      CREATE TABLE IF NOT EXISTS github_task_links(task_id TEXT NOT NULL REFERENCES collaboration_tasks(id) ON DELETE CASCADE,object_id TEXT NOT NULL REFERENCES github_objects(id),PRIMARY KEY(task_id,object_id));")?;
    super::installed::migrate(db)
}
fn repository(db: &Connection, id: i64) -> Result<Value> {
    let raw: String = db.query_row(
        "SELECT data FROM github_repositories WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&raw)?)
}
fn save_repository(db: &Connection, repo: &Repository) -> Result<()> {
    let data = json!({"id":repo.id,"fullName":repo.full_name,"url":format!("https://github.com/{}",repo.full_name),"syncedAt":now(),"lastAttemptAt":now(),"error":null});
    db.execute("INSERT INTO github_repositories(id,data) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET data=excluded.data",params![repo.id,data.to_string()])?;
    Ok(())
}
fn decorate(
    db: &Connection,
    id: &str,
    repo: i64,
    kind: &str,
    number: u64,
    raw: &str,
) -> Result<Value> {
    let r = repository(db, repo)?;
    decorate_named(
        id,
        repo,
        kind,
        number,
        raw,
        r["fullName"].as_str().unwrap_or(""),
    )
}
fn decorate_named(
    id: &str,
    repo: i64,
    kind: &str,
    number: u64,
    raw: &str,
    name: &str,
) -> Result<Value> {
    let mut v: Value = serde_json::from_str(raw)?;
    v["id"] = json!(id);
    v["repositoryId"] = json!(repo);
    v["repository"] = json!(name);
    v["kind"] = json!(kind);
    v["number"] = json!(number);
    v["url"] = json!(format!(
        "https://github.com/{}/{}/{}",
        name,
        if kind == "pull" { "pull" } else { "issues" },
        number
    ));
    let old = v["syncedAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_none_or(|t| chrono::Utc::now().signed_duration_since(t).num_seconds() > 180);
    // A merged PR is final: GitHub cannot reopen it, so its state and head
    // no longer change however old the read (YN-193).
    let merged = v["snapshot"]["state"] == "merged";
    v["stale"] = json!((old && !merged) || !v["error"].is_null());
    Ok(v)
}
pub(crate) fn task_links(db: &Connection, task: &str) -> Result<Vec<Value>> {
    let mut q=db.prepare("SELECT o.id,o.repo_id,o.kind,o.number,o.data FROM github_objects o JOIN github_task_links l ON l.object_id=o.id WHERE l.task_id=?1 ORDER BY o.repo_id,o.kind,o.number")?;
    let rows = q.query_map([task], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, i64>(1)?,
            r.get::<_, String>(2)?,
            r.get::<_, i64>(3)? as u64,
            r.get::<_, String>(4)?,
        ))
    })?;
    rows.map(|row| {
        let (id, repo, kind, number, raw) = row?;
        decorate(db, &id, repo, &kind, number, &raw)
    })
    .collect()
}

/// The pull request `owner/repo#number` this task links (YN-208, a result's
/// deliverable): its repository's ID and name as Core keeps them, and its
/// title as Core last read it. None when the task does not link it. GitHub
/// names compare without case, as GitHub does.
pub(crate) fn task_pull(db: &Connection, task: &str, full_name: &str, number: u64) -> Result<Option<(i64, String, Option<String>)>> {
    Ok(db
        .query_row(
            "SELECT o.repo_id,json_extract(r.data,'$.fullName'),json_extract(o.data,'$.snapshot.title') FROM github_task_links l
             JOIN github_objects o ON o.id=l.object_id JOIN github_repositories r ON r.id=o.repo_id
             WHERE l.task_id=?1 AND o.kind='pull' AND o.number=?2 AND lower(json_extract(r.data,'$.fullName'))=lower(?3)",
            params![task, number as i64, full_name],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?)
}

/// A pull request's state and when Core read it from GitHub (YN-208): the
/// snapshot Core keeps, never a new read. None when Core keeps none.
pub(crate) fn pull_state(db: &Connection, repo: i64, number: u64) -> Result<Option<(String, Option<String>)>> {
    Ok(db
        .query_row(
            "SELECT json_extract(data,'$.snapshot.state'),json_extract(data,'$.snapshot.observedAt') FROM github_objects
             WHERE repo_id=?1 AND kind='pull' AND number=?2",
            params![repo, number as i64],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?)),
        )
        .optional()?
        .and_then(|(state, at)| state.map(|state| (state, at))))
}

/// The repository `owner/repo` linked to this Project (YN-208): its ID and
/// name as Core keeps them; None when the Project does not link it.
pub(crate) fn project_repository(db: &Connection, project: &str, full_name: &str) -> Result<Option<(i64, String)>> {
    Ok(db
        .query_row(
            "SELECT r.id,json_extract(r.data,'$.fullName') FROM github_project_repos p JOIN github_repositories r ON r.id=p.repo_id
             WHERE p.project_id=?1 AND lower(json_extract(r.data,'$.fullName'))=lower(?2)",
            params![project, full_name],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?)
}

/// One bounded query for the task-list page; omit individual check runs.
pub(crate) fn task_summaries(
    db: &Connection,
    ids: &[&str],
) -> Result<std::collections::HashMap<String, Vec<Value>>> {
    let mut result = std::collections::HashMap::new();
    if ids.is_empty() {
        return Ok(result);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let mut q=db.prepare(&format!("SELECT l.task_id,o.id,o.repo_id,o.kind,o.number,json_remove(o.data,'$.snapshot.ci.checks'),json_extract(r.data,'$.fullName') FROM github_task_links l JOIN github_objects o ON o.id=l.object_id JOIN github_repositories r ON r.id=o.repo_id WHERE l.task_id IN ({placeholders}) ORDER BY o.repo_id,o.kind,o.number"))?;
    let rows = q.query_map(rusqlite::params_from_iter(ids), |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, i64>(2)?,
            r.get::<_, String>(3)?,
            r.get::<_, i64>(4)? as u64,
            r.get::<_, String>(5)?,
            r.get::<_, String>(6)?,
        ))
    })?;
    for row in rows {
        let (task, id, repo, kind, number, raw, name) = row?;
        result
            .entry(task)
            .or_insert_with(Vec::new)
            .push(decorate_named(&id, repo, &kind, number, &raw, &name)?);
    }
    Ok(result)
}

/// How many GitHub objects each of these tasks links, in one query: what a
/// compact task row shows of them (T-201).
pub(crate) fn task_link_counts(db: &Connection, ids: &[&str]) -> Result<std::collections::HashMap<String, i64>> {
    let mut result = std::collections::HashMap::new();
    if ids.is_empty() {
        return Ok(result);
    }
    let placeholders = vec!["?"; ids.len()].join(",");
    let mut q = db.prepare(&format!("SELECT task_id,COUNT(*) FROM github_task_links WHERE task_id IN ({placeholders}) GROUP BY task_id"))?;
    let rows = q.query_map(rusqlite::params_from_iter(ids), |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?;
    for row in rows {
        let (task, count) = row?;
        result.insert(task, count);
    }
    Ok(result)
}

/// The most GitHub objects one task links that are not merged PRs: open
/// ones, drafts, Issues, and closed ones, which can be reopened, so
/// github_refresh still reads them. A merged PR is final: it takes no place
/// and is not read again (YN-193). Unlinking one frees its place.
pub(crate) const TASK_LINK_LIMIT: i64 = 30;
/// The most GitHub objects one task links at all, merged PRs included, so a
/// task's links stay bounded (YN-193): 30 places plus 70 merged PRs, whose
/// short rows in task_get stay near 25 KB.
pub(crate) const TASK_LINK_TOTAL: i64 = 100;
/// How many of a task's links, other than `except`, are not merged PRs, and
/// how many there are in all.
fn link_counts(db: &Connection, task: &str, except: &str) -> Result<(i64, i64)> {
    Ok(db.query_row(
        "SELECT COUNT(*) FILTER (WHERE COALESCE(json_extract(o.data,'$.snapshot.state'),'')<>'merged'),COUNT(*)
           FROM github_task_links l JOIN github_objects o ON o.id=l.object_id WHERE l.task_id=?1 AND l.object_id<>?2",
        params![task, except],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?)
}

/// How full a task's links are, beside the links themselves in each
/// github_links answer for a task (T-204).
fn link_capacity(db: &Connection, task: &str) -> Result<Value> {
    let (counted, linked) = link_counts(db, task, "")?;
    Ok(json!({
        "linkedCount": linked,
        "countedCount": counted,
        "limit": TASK_LINK_LIMIT,
        "remaining": (TASK_LINK_LIMIT - counted).max(0).min(TASK_LINK_TOTAL - linked),
        "totalLimit": TASK_LINK_TOTAL,
        "note": "limit counts the PRs and Issues linked to this task that are not merged PRs (countedCount); closed ones count, since they can be reopened. A merged PR takes no place and github_refresh no longer reads it; all links together, merged ones too, are at most totalLimit. Linking one already linked takes no second place. When it is full, unlink one this task no longer needs (action unlink with its linkId). Nothing is unlinked for you.",
    }))
}

impl Store {
    /// A saved repository's full name, or None (T-164: where an abbreviated
    /// SHA in task materials is resolved).
    pub(crate) fn github_repository_name(&self, id: i64) -> Result<Option<String>> {
        let db = self.db.read()?;
        let raw: Option<String> = db
            .query_row("SELECT data FROM github_repositories WHERE id=?1", [id], |r| r.get(0))
            .optional()?;
        Ok(raw
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|data| data["fullName"].as_str().map(str::to_owned)))
    }
    pub(crate) fn github_list(&self, project: Option<&str>, task: Option<&str>) -> Result<Value> {
        let db = self.db.read()?;
        let mut repos = Vec::new();
        let mut links = Vec::new();
        if let Some(project) = project {
            crate::projects::ensure_exists(&db, project)?;
            let mut q=db.prepare("SELECT r.data FROM github_repositories r JOIN github_project_repos p ON p.repo_id=r.id WHERE p.project_id=?1 ORDER BY r.id")?;
            for row in q.query_map([project], |r| r.get::<_, String>(0))? {
                repos.push(serde_json::from_str::<Value>(&row?)?);
            }
        }
        let mut capacity = None;
        if let Some(task) = task {
            let id = crate::collaboration_store::task_key(&db, task)?.0;
            links = task_links(&db, &id)?;
            capacity = Some(link_capacity(&db, &id)?);
        }
        let mut page = json!({"repositories":repos,"links":links,"source":{"host":"Core host","authentication":"GitHub CLI (gh) on the Core host","provider":"github.com"}});
        if let Some(capacity) = capacity {
            page["capacity"] = capacity;
        }
        Ok(page)
    }
    pub(crate) fn github_link_repo(&self, project: &str, repo: &Repository) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        crate::projects::ensure_assignable(&tx, project)?;
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM github_project_repos WHERE project_id=?1 AND repo_id!=?2",
            params![project, repo.id],
            |r| r.get(0),
        )?;
        ensure!(count < 20, "A project can link up to 20 repositories");
        save_repository(&tx, repo)?;
        tx.execute(
            "INSERT OR IGNORE INTO github_project_repos(project_id,repo_id) VALUES(?1,?2)",
            params![project, repo.id],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn github_unlink_repo(&self, project: &str, repo: i64) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        crate::projects::ensure_exists(&tx, project)?;
        // Task links remain explicit records even if the Project stops listing a repo.
        tx.execute(
            "DELETE FROM github_project_repos WHERE project_id=?1 AND repo_id=?2",
            params![project, repo],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn github_link_object(
        &self,
        task: &str,
        repo: &Repository,
        kind: &str,
        number: u64,
        snapshot: Value,
    ) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        link_object(&tx, task, repo, kind, number, snapshot)?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn github_unlink_object(&self, task: &str, id: &str) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let task = crate::collaboration_store::task_key(&tx, task)?.0;
        tx.execute(
            "DELETE FROM github_task_links WHERE task_id=?1 AND object_id=?2",
            params![task, id],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn github_refresh_repo(
        &self,
        id: i64,
        result: std::result::Result<Repository, String>,
    ) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        match result {
            Ok(repo) => {
                ensure!(repo.id == id, "Repository identity changed");
                save_repository(&tx, &repo)?;
            }
            Err(error) => {
                let mut v = repository(&tx, id)?;
                v["lastAttemptAt"] = json!(now());
                v["error"] = json!(error);
                tx.execute(
                    "UPDATE github_repositories SET data=?1 WHERE id=?2",
                    params![v.to_string(), id],
                )?;
            }
        }
        tx.commit()?;
        Ok(())
    }
    pub(crate) fn github_refresh_object(
        &self,
        id: &str,
        result: std::result::Result<(Repository, Value), String>,
    ) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let raw: Option<String> = tx
            .query_row("SELECT data FROM github_objects WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()?;
        let Some(raw) = raw else { return Ok(()) };
        let mut data: Value = serde_json::from_str(&raw)?;
        data["lastAttemptAt"] = json!(now());
        match result {
            Ok((repo, snapshot)) => {
                save_repository(&tx, &repo)?;
                data["snapshot"] = snapshot;
                data["syncedAt"] = json!(now());
                data["error"] = Value::Null;
            }
            Err(error) => {
                data["error"] = json!(error);
            }
        }
        tx.execute(
            "UPDATE github_objects SET data=?1 WHERE id=?2",
            params![data.to_string(), id],
        )?;
        tx.commit()?;
        Ok(())
    }
}

/// Reuse task/project checks inside a caller's existing write transaction.
pub(crate) fn link_object(
    db: &Connection,
    task: &str,
    repo: &Repository,
    kind: &str,
    number: u64,
    snapshot: Value,
) -> Result<()> {
    let task = crate::collaboration_store::task_key(db, task)?.0;
    let project: Option<String> = db
        .query_row(
            "SELECT project_id FROM project_tasks WHERE task_id=?1",
            [&task],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(project) = project {
        let linked: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM github_project_repos WHERE project_id=?1 AND repo_id=?2)",
            params![project, repo.id],
            |r| r.get(0),
        )?;
        ensure!(
            linked,
            "Link this repository in the task's Project settings first"
        );
    }
    let id = format!("{}:{kind}:{number}", repo.id);
    let (counted, linked) = link_counts(db, &task, &id)?;
    ensure!(
        (counted < TASK_LINK_LIMIT || snapshot["state"] == "merged") && linked < TASK_LINK_TOTAL,
        "link_limit_reached: this task already links {linked} GitHub objects, {counted} of them not merged PRs \
         (countedCount {counted}, limit {TASK_LINK_LIMIT}; linkedCount {linked}, totalLimit {TASK_LINK_TOTAL}). \
         Nothing was linked. Merged PRs take no place in limit; closed ones do. To link this one, first unlink one \
         this task no longer needs (github_links action unlink with its linkId)."
    );
    save_repository(db, repo)?;
    let data = json!({"snapshot":snapshot,"syncedAt":now(),"lastAttemptAt":now(),"error":null});
    // Re-link is idempotent and must not overwrite a newer refresh snapshot.
    db.execute(
        "INSERT OR IGNORE INTO github_objects(id,repo_id,kind,number,data) VALUES(?1,?2,?3,?4,?5)",
        params![id, repo.id, kind, number as i64, data.to_string()],
    )?;
    db.execute(
        "INSERT OR IGNORE INTO github_task_links(task_id,object_id) VALUES(?1,?2)",
        params![task, id],
    )?;
    Ok(())
}
