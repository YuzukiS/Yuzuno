//! The rule layer (YN-74 ③b; design YN-72 v3, 3.1 to 3.4, 3.3).
//!
//! Every hour Core itself, with no Agent, looks at each Project's folder on
//! this host and the worktrees its repository registers:
//!
//! - a folder a rule on for that Project recognizes goes after `keepDays`
//!   (the YN-65 setting, default 1 day) and its own freshness (`freshDays`);
//! - a worktree that this Project's repository registers, that is not the
//!   main one nor locked, whose Git status is empty, whose HEAD is proven
//!   kept elsewhere (an ancestor of `refs/remotes/origin/main`, the tip of
//!   its same-named branch on `origin` when `git ls-remote` says so now, or
//!   the head of a merged or closed pull request Core recorded for that
//!   Project's repository), with no process, Job or Agent using it, whose
//!   ignored content fits a snapshot, and whose last use is `worktreeKeepDays`
//!   (default 7) old, is reclaimed through `apply::execute_checked`, the same
//!   checked path a manual plan takes: a snapshot, a pinned ref
//!   (`refs/yuzuno/reclaimed/...`), the removal, and only its own Git record.
//!
//! What cannot be decided goes to the to-tidy list: commits of its own, a
//! question only `git cherry` could answer, a snapshot over the limit, an
//! unknown Git answer, and a closed task's recorded folders. The list is
//! information for the next cleanup executor, never a deletion: no entry
//! authorizes anything.
//!
//! Every run and item is kept under its own `cleanup_automatic_*` tables
//! with the Project, machine, task (or none), policy version and settings,
//! its evidence, the path's identity and HEAD, and its result, snapshot and
//! ref. An item is recorded before it is touched; an interrupted removal is
//! never retried. Only a database with no user table at all is a new install
//! (both switches on); an upgrade keeps them off (settings.rs).
use super::*;
use crate::build_output::{git, git_status, inside};
use apply::{execute_checked, Outcome, Removal};
use anyhow::ensure;
use serde::Deserialize;

/// A pass every hour; the first a minute after Core starts (YN-65's TICK).
const TICK: Duration = Duration::from_secs(3600);
pub(crate) const FIRST: Duration = Duration::from_secs(60);
/// The walk of one Project folder: the existing finder's bounds.
const DEPTH: usize = 6;
const WALK_ENTRIES: usize = 2_000_000;
const WALK_TIME: Duration = Duration::from_secs(20);
/// Candidates one Project handles in one pass, so the other Projects get
/// their turn in the same hour; the rest is reached on later passes.
const PER_PASS: usize = 40;
/// Projects one pass starts on, least recently run first.
const PROJECTS_PER_PASS: usize = 4;
/// The to-tidy list is bounded; the oldest seen beyond this go.
const MAX_TIDY: i64 = 5_000;
/// A Git file written further in the future than this is not believed.
const FUTURE_MINUTES: i64 = 5;
/// The ref namespace for a worktree no task owns.
pub(crate) const AUTOMATIC: &str = "automatic";

/// A candidate the walk found, or a worktree the repository registers.
#[derive(Clone, Debug)]
struct Candidate {
    kind: &'static str,
    path: PathBuf,
    rule: Option<String>,
    basis: Option<String>,
    listed: Option<check::Listed>,
}

#[derive(Clone, Debug, Default)]
struct Found {
    items: Vec<Candidate>,
    incomplete: bool,
}

fn key(candidate: &Candidate) -> String {
    candidate.path.to_string_lossy().into_owned()
}

/// The candidates sorted, starting after the cursor and wrapping: every
/// pass begins where the last one stopped, so nothing is starved.
fn rotate(items: &mut [Candidate], after: Option<&str>) {
    items.sort_by_key(key);
    if let Some(after) = after {
        let at = items.partition_point(|c| key(c).as_str() <= after);
        items.rotate_left(at);
    }
}

fn real(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The walk of one root, never following a link and never going into a
/// recognized cache, `.git`, a protected path, a mount or another Project.
/// It stops at the existing bounds; over a bound the result says it did not
/// see everything rather than pretending it did.
fn walk(ctx: &check::Context, roots: &[PathBuf], limit: usize, after: Option<&str>) -> Found {
    let (mut found, mut entries) = (Found::default(), 0usize);
    let deadline = Instant::now() + WALK_TIME;
    let mut start = Vec::new();
    for root in roots {
        start.push((real(root), 0usize));
    }
    while let Some((dir, depth)) = start.pop() {
        let Ok(read) = std::fs::read_dir(&dir) else {
            found.incomplete = true;
            continue;
        };
        let mut children = Vec::new();
        for entry in read.flatten() {
            entries += 1;
            if entries > WALK_ENTRIES || Instant::now() > deadline {
                found.incomplete = true;
                return found;
            }
            let path = entry.path();
            let Ok(meta) = std::fs::symlink_metadata(&path) else { continue };
            if meta.file_type().is_symlink() || !meta.is_dir() {
                continue;
            }
            if path.file_name().is_some_and(|name| name == ".git") {
                continue;
            }
            // A folder the user protects, one reached through a mount, and
            // another Project's are not walked at all.
            if ctx.protected.iter().any(|p| inside(&path, p)) || inside(&path, &ctx.data)
                || ctx.others.iter().any(|o| inside(&path, o))
                || ctx.mounts.as_ref().is_some_and(|mounts| mounts.iter().any(|m| inside(m, &path)))
            {
                continue;
            }
            if std::fs::symlink_metadata(path.join(".git")).is_ok() {
                // A Git working tree or repository: never a cache, and not
                // another repository's folders either.
                children.push((path, depth + 1, false));
                continue;
            }
            let recognized = check::recognize(&path, &ctx.on, true, false);
            match recognized {
                Ok(Some((rule, basis))) => {
                    // A recognized cache goes as one; nothing in it is a
                    // separate candidate.
                    if after.is_none_or(|after| path.to_string_lossy().as_ref() > after) {
                        found.items.push(Candidate { kind: "cache-dir", path, rule: Some(rule.to_owned()),
                            basis: Some(basis), listed: None });
                    }
                    if found.items.len() >= limit {
                        found.incomplete = true;
                        return found;
                    }
                }
                // A rule that is off still marks the folder's whole tree: its
                // contents are not separate candidates.
                Err(_) => {}
                Ok(None) => {
                    if depth < DEPTH {
                        children.push((path, depth + 1, true));
                    }
                }
            }
        }
        // Depth first, so a shallower candidate is found before its contents.
        children.sort_by(|a, b| b.0.cmp(&a.0));
        for (path, depth, descend) in children {
            if descend {
                start.push((path, depth));
            }
        }
    }
    found
}

/// A cursor, kept per Project and machine and kind (cache, worktree).
fn cursor(store: &Store, project: &str, kind: &str) -> Result<Option<String>> {
    let db = store.db.read()?;
    Ok(db
        .query_row("SELECT last_key FROM cleanup_automatic_cursors WHERE project_id=?1 AND machine='local' AND kind=?2",
            params![project, kind], |r| r.get(0))
        .optional()?)
}

fn set_cursor(store: &Store, project: &str, kind: &str, last: &str) -> Result<()> {
    store.db.write()?.execute(
        "INSERT INTO cleanup_automatic_cursors(project_id,machine,kind,last_key) VALUES(?1,'local',?2,?3)
         ON CONFLICT(project_id,machine,kind) DO UPDATE SET last_key=excluded.last_key",
        params![project, kind, last],
    )?;
    Ok(())
}

fn begin_run(store: &Store, project: &str, settings: &Settings) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    store.db.write()?.execute(
        "INSERT INTO cleanup_automatic_runs(id,project_id,machine,task_id,policy_version,params,state,started_at,finished_at,data)
         VALUES(?1,?2,'local',NULL,?3,?4,'running',?5,NULL,'{}')",
        params![id, project, settings.version, serde_json::to_string(settings)?, now()],
    )?;
    Ok(id)
}

fn finish_run(store: &Store, run: &str, state: &str, data: Value) -> Result<()> {
    store.db.write()?.execute(
        "UPDATE cleanup_automatic_runs SET state=?2,finished_at=?3,data=?4 WHERE id=?1 AND state='running'",
        params![run, state, now(), data.to_string()],
    )?;
    Ok(())
}

/// An item is recorded before anything is touched; then it is marked removing,
/// so a Core that stops here leaves it interrupted and never tries it again.
#[allow(clippy::too_many_arguments)]
fn plan_item(store: &Store, run: &str, seq: i64, candidate: &Candidate, task: Option<&str>, evidence: &Value, pre: &Value) -> Result<String> {
    let id = seq.to_string();
    store.db.write()?.execute(
        "INSERT INTO cleanup_automatic_items(run_id,item_id,seq,kind,path,task_id,state,evidence,pre,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,'planned',?7,?8,?9)",
        params![run, id, seq, candidate.kind, candidate.path.to_string_lossy(), task, evidence.to_string(), pre.to_string(), now()],
    )?;
    Ok(id)
}

/// A worktree's removal has its snapshot and pinned HEAD on record before the
/// first destructive action; a Core that stops from here can still be
/// restored, and never retries the path automatically.
fn save_prepared(store: &Store, run: &str, item: &str, record: &Value, snapshot: &Value) -> Result<()> {
    store.db.write()?.execute(
        "UPDATE cleanup_automatic_items SET state='prepared',
            result=json_set(COALESCE(result,'{}'),'$.code','prepared','$.ref',?4,'$.head',?5,'$.branch',?6),
            snapshot=?3,ref=?4,updated_at=?7 WHERE run_id=?1 AND item_id=?2",
        params![run, item, snapshot.to_string(), record["ref"].as_str(), record["head"].as_str(), record["branch"].as_str(), now()],
    )?;
    Ok(())
}

fn mark_removing(store: &Store, run: &str, item: &str) -> Result<()> {
    store.db.write()?.execute(
        "UPDATE cleanup_automatic_items SET state='removing',updated_at=?3 WHERE run_id=?1 AND item_id=?2",
        params![run, item, now()],
    )?;
    Ok(())
}

/// A path Core once interrupted is never tried automatically again: the next
/// pass finds it, keeps it, and says which earlier run stopped there.
fn prior_attempt(store: &Store, path: &Path) -> Result<Option<(String, String)>> {
    let db = store.db.read()?;
    Ok(db.query_row(
        "SELECT state,run_id FROM cleanup_automatic_items WHERE path=?1
           AND state IN ('planned','prepared','removing','interrupted','partial','restored')
         ORDER BY updated_at DESC LIMIT 1",
        [path.to_string_lossy().as_ref()], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
}

#[allow(clippy::too_many_arguments)]
fn keep_item(store: &Store, run: &str, seq: i64, candidate: &Candidate, task: Option<&str>, evidence: &Value, state: &str, result: Value) -> Result<()> {
    store.db.write()?.execute(
        "INSERT INTO cleanup_automatic_items(run_id,item_id,seq,kind,path,task_id,state,evidence,pre,result,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'{}',?9,?10)",
        params![run, seq.to_string(), seq, candidate.kind, candidate.path.to_string_lossy(), task, state, evidence.to_string(), result.to_string(), now()],
    )?;
    Ok(())
}

fn finish_item(store: &Store, run: &str, item: &str, outcome: &Outcome) -> Result<()> {
    let reference = outcome.result["ref"].as_str();
    store.db.write()?.execute(
        "UPDATE cleanup_automatic_items SET state=?3,result=?4,snapshot=?5,ref=?6,updated_at=?7 WHERE run_id=?1 AND item_id=?2",
        params![run, item, outcome.state, outcome.result.to_string(), outcome.snapshot.as_ref().map(Value::to_string),
            reference, now()],
    )?;
    Ok(())
}

/// A run a stopped Core left running, and the item it was removing: kept as
/// interrupted or partial, never retried (design 3.2's restart rule).
pub(crate) fn recover(store: &Store) -> Result<usize> {
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    let runs: Vec<String> = {
        let mut q = tx.prepare("SELECT id FROM cleanup_automatic_runs WHERE state='running'")?;
        let rows = q.query_map([], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for run in &runs {
        let why = "Core stopped while this automatic pass ran; what it had not finished is left as it was, and nothing is retried";
        tx.execute(
            "UPDATE cleanup_automatic_items SET state='interrupted',
                result=json_set(COALESCE(result,'{}'),'$.code','interrupted','$.why',?2),updated_at=?3
              WHERE run_id=?1 AND state IN ('planned','prepared','removing')",
            params![run, why, now()],
        )?;
        tx.execute("UPDATE cleanup_automatic_runs SET state='interrupted',finished_at=?2,data=json_set(data,'$.note',?3) WHERE id=?1",
            params![run, now(), why])?;
    }
    tx.commit()?;
    Ok(runs.len())
}

/// What the time condition found: why a worktree is old enough, or why not.
struct Age {
    evidence: Value,
    refusal: Option<(&'static str, String)>,
}

fn parse_time(text: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(text).ok().map(|t| t.with_timezone(&chrono::Utc))
}

fn days_since(at: chrono::DateTime<chrono::Utc>) -> f64 {
    (chrono::Utc::now() - at).num_milliseconds() as f64 / 86_400_000.0
}

/// Days since a file system write recorded in nanoseconds.
fn days_since_ns(ns: i128) -> f64 {
    let now = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(i64::MAX) as i128;
    (now - ns) as f64 / 86_400e9
}

/// Related local executors and Jobs, and the newest thing Core's records say
/// about the worktree. Reuse: a Job run there after its release counts as
/// newer activity than the release (Lead, design 3.2).
fn records_age(store: &Store, path: &Path, settings: &Settings, common: &str) -> Result<Age> {
    let text = path.to_string_lossy().into_owned();
    let prefix = format!("{text}/");
    let db = store.db.read()?;
    let mut q = db.prepare(
        "SELECT r.agent_id,r.task_id,r.archived_at,json_extract(a.data,'$.cwd')
         FROM agent_roles r JOIN agents a ON a.id=r.agent_id
         WHERE r.kind='executor' AND json_extract(a.data,'$.remote') IS NULL
           AND (json_extract(a.data,'$.cwd')=?1 OR substr(json_extract(a.data,'$.cwd'),1,length(?2))=?2)",
    )?;
    type ExecutorRow = (String, Option<String>, Option<String>, Option<String>);
    let rows: Vec<ExecutorRow> = q
        .query_map(params![text, prefix], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if let Some((agent, _, _, _)) = rows.iter().find(|(_, _, archived, _)| archived.is_none()) {
        return Ok(Age { evidence: json!({"openExecutor": agent, "eligible": false}),
            refusal: Some(("inUse", format!("Executor {agent} is still open in it"))) });
    }
    let mut q = db.prepare(
        "SELECT json_extract(j.data,'$.cwd'),json_extract(j.data,'$.startedAt'),json_extract(j.data,'$.finishedAt'),
                COALESCE(j.status,json_extract(j.data,'$.status'))
         FROM local_jobs j WHERE COALESCE(json_extract(j.data,'$.target.kind'),'local')='local'
           AND (json_extract(j.data,'$.cwd')=?1 OR substr(json_extract(j.data,'$.cwd'),1,length(?2))=?2) ORDER BY j.seq DESC LIMIT 500",
    )?;
    type JobRow = (Option<String>, Option<String>, Option<String>, Option<String>);
    let jobs: Vec<JobRow> = q
        .query_map(params![text, prefix], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    if let Some(job) = jobs.iter().find(|(_, _, _, status)| status.as_deref().is_some_and(|s| matches!(s, "running" | "queued" | "pending"))) {
        return Ok(Age { evidence: json!({"job": job.0, "status": job.3, "eligible": false}),
            refusal: Some(("inUse", format!("A Job is still {} in it", job.3.as_deref().unwrap_or("open")))) });
    }
    let released = rows.iter().filter_map(|(_, _, at, _)| at.as_deref().and_then(parse_time)).max();
    let job_at = jobs.iter().filter_map(|(_, started, finished, _)| finished.as_deref().or(started.as_deref()).and_then(parse_time)).max();
    let newest = match (released, job_at) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    };
    if let Some(newest) = newest {
        let age = days_since(newest);
        let keep = f64::from(settings.worktree_keep_days);
        let task = rows.iter().find_map(|(_, task, at, _)| at.as_deref().and_then(parse_time).map(|t| (t, task.clone())))
            .filter(|(t, _)| Some(*t) == released).and_then(|(_, task)| task);
        let evidence = json!({"basis": "executor release", "releaseAt": released.map(|t| t.to_rfc3339()),
            "newestUseAt": newest.to_rfc3339(), "ageDays": age, "keepDays": settings.worktree_keep_days, "taskId": task,
            "eligible": age >= keep});
        return Ok(Age { evidence,
            refusal: (age < keep).then(|| ("recent", format!("Used within the last {keep} days (Settings)"))) });
    }
    let at = git_activity(path, common)?;
    let age = days_since(at);
    let keep = f64::from(settings.worktree_keep_days);
    Ok(Age { evidence: json!({"basis": "Git activity", "at": at.to_rfc3339(),
        "ageDays": age, "keepDays": settings.worktree_keep_days, "taskId": null, "eligible": age >= keep}),
        refusal: (age < keep).then(|| ("recent", format!("Last Git activity within {keep} days (Settings)"))) })
}

/// A linked worktree's own Git metadata: `.git`, the gitdir it names (checked
/// to be this repository's record), HEAD, and the existing index, logs,
/// operation state. A missing, unreadable, foreign or future entry means the
/// age is not known, and an unknown age never removes.
fn git_activity(path: &Path, common: &str) -> Result<chrono::DateTime<chrono::Utc>> {
    let git = path.join(".git");
    let meta = std::fs::symlink_metadata(&git).map_err(|e| anyhow::anyhow!("Its .git cannot be read: {e}"))?;
    let mut times = vec![meta.modified().map_err(|e| anyhow::anyhow!("Its .git has no time: {e}"))?];
    let gitdir = if meta.is_dir() {
        git.to_path_buf()
    } else {
        let text = std::fs::read_to_string(&git).map_err(|e| anyhow::anyhow!("Its .git cannot be read: {e}"))?;
        let named = text.strip_prefix("gitdir: ").map(str::trim).filter(|p| !p.is_empty())
            .ok_or_else(|| anyhow::anyhow!("Its .git names no gitdir"))?;
        let named = Path::new(named);
        std::fs::canonicalize(if named.is_absolute() { named.to_path_buf() } else { path.join(named) })
            .map_err(|e| anyhow::anyhow!("Its gitdir cannot be read: {e}"))?
    };
    // A linked worktree's gitdir is one of this repository's records; a path
    // that leaves it is not this worktree's metadata.
    let records = Path::new(common).join("worktrees");
    if !inside(&gitdir, &records) {
        anyhow::bail!("Its gitdir is not one of this repository's worktree records");
    }
    let meta = std::fs::symlink_metadata(gitdir.join("HEAD")).map_err(|e| anyhow::anyhow!("Its HEAD cannot be read: {e}"))?;
    times.push(meta.modified()?);
    for relative in ["index", "ORIG_HEAD", "FETCH_HEAD", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG",
        "rebase-merge", "rebase-apply", "sequencer", "logs/HEAD"] {
        if let Ok(meta) = std::fs::symlink_metadata(gitdir.join(relative)) {
            times.push(meta.modified().map_err(|e| anyhow::anyhow!("Its {relative} has no time: {e}"))?);
        }
    }
    let newest = times.into_iter().max().ok_or_else(|| anyhow::anyhow!("It has no Git time"))?;
    let at: chrono::DateTime<chrono::Utc> = newest.into();
    if at > chrono::Utc::now() + chrono::Duration::minutes(FUTURE_MINUTES) {
        anyhow::bail!("Its Git time is in the future");
    }
    Ok(at)
}

/// The remote branch tip `git ls-remote` returns now for this worktree's
/// branch, if it names exactly its HEAD. A bound is the existing Git helper's
/// (8 seconds, bounded output, no prompt); a failure is unknown, not false.
async fn remote_tip(path: &Path, branch: &str, head: &str) -> Value {
    let reference = format!("refs/heads/{branch}");
    match git(path, &["ls-remote", "--heads", "origin", &reference]).await {
        Ok(Ok(text)) => {
            let found: Vec<&str> = text.lines().filter_map(|line| {
                let (sha, name) = line.split_once('\t')?;
                (name.trim() == reference && sha.len() == 40 && sha.bytes().all(|b| b.is_ascii_hexdigit())).then_some(sha)
            }).collect();
            match found.as_slice() {
                [sha] => json!({"result": sha.eq_ignore_ascii_case(head), "head": sha, "reference": reference}),
                [] => json!({"result": false, "reference": reference, "why": "origin has no such branch"}),
                _ => json!({"result": null, "reference": reference, "why": "origin returned several such branches"}),
            }
        }
        Ok(Err(why)) => json!({"result": null, "reference": reference, "why": why}),
        Err(error) => json!({"result": null, "reference": reference, "why": format!("{error:#}")}),
    }
}

/// The repository this Project's folder pushes to, as GitHub names it, when
/// it can be told (`origin`'s URL).
async fn repository_name(path: &Path) -> Option<String> {
    let url = git(path, &["config", "--get", "remote.origin.url"]).await.ok()?.ok()?.trim().to_owned();
    let tail = url.rsplit("github.com").next()?.trim_start_matches([':', '/']);
    let tail = tail.trim_end_matches(".git");
    let mut parts = tail.split('/').filter(|p| !p.is_empty());
    let (owner, repo) = (parts.next()?, parts.next()?);
    Some(format!("{owner}/{repo}"))
}

/// A merged or closed pull request of this Project's same repository whose
/// head is exactly this HEAD, as Core recorded it. A snapshot with a refresh
/// error, a missing field or an unreadable time is no proof.
fn poll_request_proof(store: &Store, project: &str, repository: Option<&str>, head: &str) -> Result<Value> {
    let Some(repository) = repository else {
        return Ok(json!({"result": null, "why": "the repository's GitHub name cannot be told from origin"}));
    };
    let db = store.db.read()?;
    let repo: Option<i64> = db.query_row(
        "SELECT r.id FROM github_repositories r JOIN github_project_repos p ON p.repo_id=r.id
         WHERE p.project_id=?1 AND lower(json_extract(r.data,'$.fullName'))=lower(?2) LIMIT 1",
        params![project, repository], |r| r.get(0)).optional()?;
    let Some(repo) = repo else {
        return Ok(json!({"result": null, "repository": repository, "why": "the Project does not link that repository in Core"}));
    };
    let mut q = db.prepare(
        "SELECT o.number,json_extract(o.data,'$.snapshot.state'),json_extract(o.data,'$.snapshot.observedAt'),
                json_type(o.data,'$.error')
         FROM github_objects o WHERE o.repo_id=?1 AND o.kind='pull'
           AND lower(json_extract(o.data,'$.snapshot.headSha'))=lower(?2)",
    )?;
    type PullRow = (i64, Option<String>, Option<String>, Option<String>);
    let rows: Vec<PullRow> = q
        .query_map(params![repo, head], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
        .collect::<rusqlite::Result<_>>()?;
    let mut best: Option<Value> = None;
    for (number, state, observed, error) in rows {
        // A refresh error or a field Core does not know is no proof.
        if error.as_deref().is_some_and(|kind| kind != "null") {
            continue;
        }
        let (Some(state), Some(observed)) = (state, observed) else { continue };
        if !matches!(state.as_str(), "merged" | "closed") || parse_time(&observed).is_none() {
            continue;
        }
        let proof = json!({"result": true, "number": number, "state": state, "observedAt": observed, "repository": repository});
        if best.as_ref().is_none_or(|b| b["observedAt"].as_str() < proof["observedAt"].as_str()) {
            best = Some(proof);
        }
    }
    Ok(best.unwrap_or_else(|| json!({"result": false, "repository": repository,
        "why": "no merged or closed pull request Core recorded has this HEAD"})))
}

/// Why a worktree may go automatically: every condition of design 3.2, each
/// proof's answer kept as true, false or unknown. Unknown never goes.
struct Eligible {
    verdict: Verdict,
    task: Option<String>,
    evidence: Value,
}

enum Verdict {
    Go(Value),
    Keep(&'static str, String),
    Tidy(&'static str, String),
}

fn keep(code: &'static str, why: impl Into<String>) -> Verdict {
    Verdict::Keep(code, why.into())
}

fn tidy(code: &'static str, why: impl Into<String>) -> Verdict {
    Verdict::Tidy(code, why.into())
}

async fn eligible(ws: &Arc<Workspace>, ctx: &check::Context, project: &str, listed: &check::Listed, settings: &Settings) -> Result<Eligible> {
    let path = listed.path.clone();
    let mut evidence = json!({"path": path, "head": listed.head, "branch": listed.branch,
        "main": listed.main, "locked": listed.locked, "prunable": listed.prunable});
    if listed.main {
        return Ok(Eligible { verdict: keep("mainWorktree", "The main worktree is never reclaimed"), task: None, evidence });
    }
    if listed.locked {
        return Ok(Eligible { verdict: keep("locked", "Its worktree is locked (git worktree lock)"), task: None, evidence });
    }
    let Some(head) = listed.head.as_deref().filter(|h| h.len() == 40 && h.bytes().all(|b| b.is_ascii_hexdigit())) else {
        return Ok(Eligible { verdict: keep("git", "Its HEAD is not known"), task: None, evidence });
    };
    let theirs = match git(&path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await {
        Ok(Ok(text)) => text.trim().to_owned(),
        _ => return Ok(Eligible { verdict: keep("git", "Git could not say which repository it belongs to"), task: None, evidence }),
    };
    if theirs != ctx.common {
        return Ok(Eligible { verdict: keep("otherRepository", "It belongs to another repository"), task: None, evidence });
    }
    let facts = match check::worktree_facts(ctx, &path).await {
        Ok(facts) => facts,
        Err(why) => return Ok(Eligible { verdict: tidy("unknownGit", format!("Git could not check it: {why}")), task: None, evidence }),
    };
    evidence["status"] = json!({"trackedChanges": facts["trackedChanges"], "untrackedFiles": facts["untrackedFiles"],
        "uniqueCommits": facts["uniqueCommits"]});
    if facts["trackedChanges"].as_u64().unwrap_or(1) != 0 || facts["untrackedFiles"].as_u64().unwrap_or(1) != 0 {
        return Ok(Eligible { verdict: keep("dirty", "Git does not see it clean: commit or remove what it holds"), task: None, evidence });
    }
    let unique = facts["uniqueCommits"].as_u64().unwrap_or(0);
    let ancestor = match git_status(&path, &["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"]).await {
        Ok(Some(0)) => json!({"result": true, "reference": "refs/remotes/origin/main"}),
        Ok(Some(1)) => json!({"result": false, "reference": "refs/remotes/origin/main"}),
        Ok(_) => json!({"result": null, "reference": "refs/remotes/origin/main", "why": "Merge base failed"}),
        Err(error) => json!({"result": null, "reference": "refs/remotes/origin/main", "why": format!("{error:#}")}),
    };
    let remote = match listed.branch.as_deref() {
        Some(branch) => remote_tip(&path, branch, head).await,
        None => json!({"result": null, "why": "It is on no branch"}),
    };
    let repository = repository_name(&ctx.project).await;
    let pull = poll_request_proof(ws.store.as_ref(), project, repository.as_deref(), head)?;
    evidence["proofs"] = json!({"ancestor": ancestor, "remoteTip": remote, "pullRequest": pull});
    let proven = [&ancestor, &remote, &pull].iter().any(|p| p["result"] == true);
    let unknown = [&ancestor, &remote, &pull].iter().any(|p| p["result"].is_null());
    if !proven {
        return Ok(Eligible { verdict: if unique > 0 {
            tidy("uniqueCommits", format!("It has {unique} commit(s) on no remote branch, and no proof its HEAD is kept elsewhere"))
        } else if unknown {
            tidy("unknownGit", "Git did not answer whether its HEAD is kept elsewhere; nothing is removed on an unknown")
        } else {
            tidy("needsCherry", "Its HEAD is on no origin/main, no same-named origin branch and no merged or closed PR Core recorded; only git cherry could decide")
        }, task: None, evidence });
    }
    let age = ws.stored({
        let path = path.clone();
        let settings = settings.clone();
        let common = ctx.common.clone();
        move |s| records_age(s, &path, &settings, &common)
    }).await?;
    let released_task = age.evidence["taskId"].as_str().map(str::to_owned);
    evidence["time"] = age.evidence;
    if let Some((code, why)) = age.refusal {
        return Ok(Eligible { verdict: keep(code, why), task: released_task, evidence });
    }
    let task = released_task.or_else(|| related_task(ws.store.as_ref(), &path).ok().flatten());
    Ok(Eligible { verdict: Verdict::Go(evidence.clone()), task, evidence })
}

/// The task that registered the worktree, when Core's records say so.
fn related_task(store: &Store, path: &Path) -> Result<Option<String>> {
    let db = store.db.read()?;
    Ok(db.query_row(
        "SELECT task_id FROM task_workspaces WHERE json_extract(data,'$.path')=?1 LIMIT 1",
        [path.to_string_lossy().as_ref()], |r| r.get(0)).optional()?)
}

/// The last proof's dependencies again, just before removal: HEAD, lock,
/// status and whichever proof was used must still hold.
async fn recheck(ws: &Arc<Workspace>, ctx: &check::Context, project: &str, listed: &check::Listed, evidence: &Value) -> std::result::Result<(), (&'static str, String)> {
    let path = listed.path.clone();
    let now_list = match git(&ctx.project, &["worktree", "list", "--porcelain"]).await {
        Ok(Ok(text)) => check::parse_worktrees(&text),
        _ => return Err(("unchecked", "Git's worktree list cannot be read now".into())),
    };
    let Some(now) = now_list.iter().find(|w| w.path == path) else {
        return Err(("changed", "Git no longer lists it as a worktree".into()));
    };
    if now.locked {
        return Err(("locked", "Its worktree is locked now".into()));
    }
    if now.head.as_deref() != listed.head.as_deref() {
        return Err(("changed", "Its HEAD changed since it was checked".into()));
    }
    let facts = check::worktree_facts(ctx, &path).await.map_err(|why| ("git", format!("Git could not check it now: {why}")))?;
    if facts["trackedChanges"].as_u64().unwrap_or(1) != 0 || facts["untrackedFiles"].as_u64().unwrap_or(1) != 0 {
        return Err(("changed", "It is no longer clean".into()));
    }
    let head = listed.head.as_deref().unwrap_or_default();
    if evidence["proofs"]["ancestor"]["result"] == true {
        match git_status(&path, &["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/main"]).await {
            Ok(Some(0)) => {}
            _ => return Err(("changed", "It is no longer an ancestor of origin/main".into())),
        }
    } else if evidence["proofs"]["remoteTip"]["result"] == true {
        let branch = listed.branch.as_deref().unwrap_or_default();
        let now = remote_tip(&path, branch, head).await;
        if now["result"] != true {
            return Err(("changed", "origin's same-named branch no longer names its HEAD".into()));
        }
    } else if evidence["proofs"]["pullRequest"]["result"] == true {
        let repository = evidence["proofs"]["pullRequest"]["repository"].as_str();
        let proof = poll_request_proof(ws.store.as_ref(), project, repository, head).map_err(|e| ("git", format!("{e:#}")))?;
        if proof["result"] != true {
            return Err(("changed", "No merged or closed pull request of that repository names its HEAD now".into()));
        }
    } else {
        return Err(("unchecked", "No proof of its HEAD was recorded".into()));
    }
    Ok(())
}

/// What one automatic pass found and did.
struct Summary {
    removed: usize,
    kept: usize,
    tidy: usize,
    failed: usize,
    incomplete: bool,
}

impl Summary {
    fn state(&self) -> &'static str {
        if self.failed > 0 { "partial" } else if self.incomplete { "incomplete" } else { "done" }
    }
}

/// One Project's automatic pass: its rule folders, then its worktrees.
async fn project_pass(ws: &Arc<Workspace>, settings: &Settings, project: &crate::projects::Project) -> Result<Summary> {
    let Some(dir) = project.default_dirs.get("local").cloned() else {
        return Ok(Summary { removed: 0, kept: 0, tidy: 0, failed: 0, incomplete: false });
    };
    let projects = ws.stored(|s| { let db = s.db.read()?; crate::projects::all(&db) }).await?;
    let others: Vec<String> = projects.iter().filter(|p| p.id != project.id).filter_map(|p| p.default_dirs.get("local").cloned()).collect();
    let ctx = match check::context(ws.cleanup.env(), ws.cleanup.mounts(), &ws.data_dir, &dir, Some(&project.id), &others, settings.clone()).await {
        Ok(ctx) => Arc::new(ctx),
        Err(error) => {
            // A Project with no folder or no Git checkout is passed over.
            if settings.rule_layer || settings.worktree_reclaim {
                let settings = settings.clone();
                ws.stored({
                    let id = project.id.clone();
                    let error = format!("{error:#}");
                    move |s| {
                        let run = begin_run(s, &id, &settings)?;
                        finish_run(s, &run, "failed", json!({"note": error}))
                    }
                }).await?;
            }
            return Ok(Summary { removed: 0, kept: 0, tidy: 0, failed: 1, incomplete: false });
        }
    };
    let run = ws.stored({
        let id = project.id.clone();
        let settings = settings.clone();
        move |s| begin_run(s, &id, &settings)
    }).await?;
    let mut summary = Summary { removed: 0, kept: 0, tidy: 0, failed: 0, incomplete: false };
    let mut seq = 0i64;
    let mut worktrees = Vec::new();
    if settings.worktree_reclaim {
        for listed in ctx.worktrees.iter().filter(|w| !w.main) {
            worktrees.push(Candidate { kind: "worktree", path: listed.path.clone(), rule: None, basis: None,
                listed: Some(listed.clone()) });
        }
        let after = ws.stored({ let id = project.id.clone(); move |s| cursor(s, &id, "worktree") }).await?;
        rotate(&mut worktrees, after.as_deref());
        worktrees.truncate(PER_PASS);
        for candidate in &worktrees {
            let Some(listed) = &candidate.listed else { continue };
            if let Some((state, earlier)) = ws.stored({ let path = candidate.path.clone(); move |s| prior_attempt(s, &path) }).await? {
                seq += 1;
                ws.stored({ let run = run.clone(); let c = candidate.clone(); let state = state.clone(); let earlier = earlier.clone();
                    move |s| keep_item(s, &run, seq, &c, None, &json!({"earlierRun": earlier, "state": state}), "kept",
                        json!({"code": "interrupted", "why": "An earlier automatic attempt on this path was interrupted or restored; it is never tried automatically again"})) }).await?;
                summary.kept += 1;
                continue;
            }
            let found = eligible(ws, &ctx, &project.id, listed, settings).await?;
            let evidence = found.evidence.clone();
            match found.verdict {
                Verdict::Keep(code, why) => {
                    seq += 1;
                    ws.stored({ let run = run.clone(); let c = candidate.clone(); let task = found.task.clone();
                        let evidence = evidence.clone(); let code = code.to_owned(); let why = why.clone();
                        move |s| keep_item(s, &run, seq, &c, task.as_deref(), &evidence, "kept", json!({"code": code, "why": why})) }).await?;
                    summary.kept += 1;
                }
                Verdict::Tidy(code, why) => {
                    seq += 1;
                    ws.stored({ let run = run.clone(); let c = candidate.clone(); let task = found.task.clone();
                        let evidence = evidence.clone(); let code = code.to_owned(); let why = why.clone();
                        let project = project.id.clone();
                        move |s| {
                            keep_item(s, &run, seq, &c, task.as_deref(), &evidence, "kept", json!({"code": code, "why": why}))?;
                            tidy_row(s, &project, "local", &c.path, task.as_deref(), &code, &why, &evidence)?;
                            Ok(())
                        } }).await?;
                    summary.tidy += 1;
                }
                Verdict::Go(evidence) => {
                    let item = check::Item { id: "auto".into(), group: "automatic".into(), kind: "worktree".into(),
                        rule: None, path: listed.path.to_string_lossy().into_owned(), save_diff: false };
                    let pre = check::preflight(&ctx, &item).await;
                    if let Some((code, why)) = pre.refusal {
                        seq += 1;
                        let tidy = code == "snapshotTooLarge" || code == "tooLarge";
                        ws.stored({ let run = run.clone(); let c = candidate.clone(); let task = found.task.clone();
                            let evidence = evidence.clone(); let code = code.to_owned(); let why = why.clone();
                            let project = project.id.clone();
                            move |s| {
                                keep_item(s, &run, seq, &c, task.as_deref(), &evidence, "kept", json!({"code": code, "why": why}))?;
                                if tidy { tidy_row(s, &project, "local", &c.path, task.as_deref(), &code, &why, &evidence)?; }
                                Ok(())
                            } }).await?;
                        if tidy { summary.tidy += 1; } else { summary.kept += 1; }
                        continue;
                    }
                    if let Err((code, why)) = recheck(ws, &ctx, &project.id, listed, &evidence).await {
                        seq += 1;
                        ws.stored({ let run = run.clone(); let c = candidate.clone(); let task = found.task.clone();
                            let evidence = evidence.clone(); let code = code.to_owned(); let why = why.clone();
                            move |s| keep_item(s, &run, seq, &c, task.as_deref(), &evidence, "kept", json!({"code": code, "why": why})) }).await?;
                        summary.kept += 1;
                        continue;
                    }
                    seq += 1;
                    let task = found.task.as_deref().unwrap_or(AUTOMATIC).to_owned();
                    let item_id = ws.stored({ let run = run.clone(); let c = candidate.clone(); let task = found.task.clone();
                        let evidence = evidence.clone(); let pre = pre.pre.clone();
                        move |s| plan_item(s, &run, seq, &c, task.as_deref(), &evidence, &pre) }).await?;
                    let path_text = candidate.path.to_string_lossy().into_owned();
                    let removal = Removal { data: &ws.data_dir, namespace: &run, task: &task, kind: "worktree",
                        id: &item_id, path: &path_text, pre: &pre.pre };
                    // The same checks a plan's item gets, then the snapshot and
                    // pinned ref recorded before the first destructive action.
                    let now_pre = match apply::checked_now(ws, &ctx, &removal).await {
                        Ok((now_pre, _)) => now_pre,
                        Err(result) => {
                            ws.stored({ let run = run.clone(); let item = item_id.clone(); let result = clone_outcome(&result);
                                move |s| finish_item(s, &run, &item, &result) }).await?;
                            count(&mut summary, &result);
                            continue;
                        }
                    };
                    let prepared = match worktrees::prepare(&ctx, &ws.data_dir, &run, &task, &item_id, &candidate.path,
                        &pre.pre, &now_pre).await {
                        Ok(prepared) => prepared,
                        Err((code, why, record, snapshot)) => {
                            let result = prepared_outcome(code, why, record, snapshot);
                            ws.stored({ let run = run.clone(); let item = item_id.clone(); let result = clone_outcome(&result);
                                move |s| finish_item(s, &run, &item, &result) }).await?;
                            count(&mut summary, &result);
                            continue;
                        }
                    };
                    // Snapshot and ref first; only then the removal. A stop in
                    // between leaves the two on record and no retry.
                    ws.stored({ let run = run.clone(); let item = item_id.clone(); let record = prepared.record.clone();
                        let snapshot = prepared.snapshot.clone();
                        move |s| save_prepared(s, &run, &item, &record, &snapshot) }).await?;
                    ws.stored({ let run = run.clone(); let item = item_id.clone(); move |s| mark_removing(s, &run, &item) }).await?;
                    #[cfg(test)]
                    if ws.cleanup.stop_after_prepare.swap(false, std::sync::atomic::Ordering::SeqCst) {
                        // The test's Core stops here: snapshot and ref are on
                        // record and the removal has not started.
                        return Ok(summary);
                    }
                    let result = match worktrees::remove_prepared(&ctx, &candidate.path, &pre.pre, prepared).await {
                        Ok((record, snapshot)) => {
                            let mut result = json!({"code": "removed", "bytes": now_pre["bytes"]});
                            for (key, value) in record.as_object().into_iter().flatten() { result[key] = value.clone(); }
                            Outcome { state: "removed", result, snapshot: Some(snapshot) }
                        }
                        Err((code, why, record, snapshot)) => prepared_outcome(code, why, record, snapshot),
                    };
                    ws.stored({ let run = run.clone(); let item = item_id.clone(); let result = clone_outcome(&result);
                        move |s| finish_item(s, &run, &item, &result) }).await?;
                    count(&mut summary, &result);
                }
            }
        }
        if let Some(last) = worktrees.last() {
            ws.stored({ let id = project.id.clone(); let last = key(last); move |s| set_cursor(s, &id, "worktree", &last) }).await?;
        }
    }
    if settings.rule_layer {
        // YN-65's keepDays is the rule layer's too (design 3.1/3.3): it never
        // shortens what a plan's own freshness already protects.
        let keep_days = ws.stored(|s| {
            let db = s.db.read()?;
            Ok(crate::build_cleanup::policy(&db)?.keep_days)
        }).await?;
        // The Project's folder, and the worktrees its repository registers
        // outside it (one inside it is covered by the folder's own walk). A
        // worktree whose folder is away for now is not a root.
        let mut roots = vec![ctx.project.clone()];
        for listed in ctx.worktrees.iter().filter(|w| !w.main && !inside(&w.path, &ctx.project)) {
            if !listed.path.is_dir() {
                continue;
            }
            // The path must still be this Project's repository's worktree: a
            // folder replaced by another repository at the same path is no
            // root of this rule layer (Lead, review of 3ca1d0c3).
            match git(&listed.path, &["rev-parse", "--path-format=absolute", "--git-common-dir"]).await {
                Ok(Ok(theirs)) if theirs.trim() == ctx.common => roots.push(listed.path.clone()),
                _ => {}
            }
        }
        roots.sort();
        roots.dedup();
        let after = ws.stored({ let id = project.id.clone(); move |s| cursor(s, &id, "cache") }).await?;
        let want = (settings.max_items as usize).min(PER_PASS);
        let ctx2 = ctx.clone();
        let mut found = tokio::task::spawn_blocking({
            let ctx = ctx2.clone();
            let roots = roots.clone();
            let after = after.clone();
            move || walk(&ctx, &roots, want, after.as_deref())
        }).await.unwrap_or_default();
        // Nothing after the cursor: the next pass starts again at the top.
        if found.items.is_empty() && after.is_some() {
            found = tokio::task::spawn_blocking(move || walk(&ctx2, &roots, want, None)).await.unwrap_or_default();
        }
        summary.incomplete |= found.incomplete;
        let mut cache = found.items;
        rotate(&mut cache, after.as_deref());
        cache.truncate(PER_PASS);
        for candidate in &cache {
            if let Some((state, earlier)) = ws.stored({ let path = candidate.path.clone(); move |s| prior_attempt(s, &path) }).await? {
                seq += 1;
                ws.stored({ let run = run.clone(); let c = candidate.clone(); let state = state.clone(); let earlier = earlier.clone();
                    move |s| keep_item(s, &run, seq, &c, None, &json!({"earlierRun": earlier, "state": state}), "kept",
                        json!({"code": "interrupted", "why": "An earlier automatic attempt on this path was interrupted or restored; it is never tried automatically again"})) }).await?;
                summary.kept += 1;
                continue;
            }
            let item = check::Item { id: "auto".into(), group: "automatic".into(), kind: "cache-dir".into(),
                rule: candidate.rule.clone(), path: candidate.path.to_string_lossy().into_owned(), save_diff: false };
            let pre = check::preflight(&ctx, &item).await;
            if let Some((code, why)) = pre.refusal {
                seq += 1;
                let evidence = json!({"rule": candidate.rule, "basis": candidate.basis});
                ws.stored({ let run = run.clone(); let c = candidate.clone(); let evidence = evidence.clone();
                    let code = code.to_owned(); let why = why.clone();
                    move |s| keep_item(s, &run, seq, &c, None, &evidence, "kept", json!({"code": code, "why": why})) }).await?;
                summary.kept += 1;
                continue;
            }
            // Cache folders wait for YN-65's keepDays as well as freshDays.
            let age = pre.pre["newestNs"].as_str().and_then(|n| n.parse::<i128>().ok()).map(days_since_ns);
            if age.is_some_and(|age| age < f64::from(keep_days)) {
                seq += 1;
                let evidence = json!({"rule": candidate.rule, "basis": candidate.basis, "ageDays": age});
                ws.stored({ let run = run.clone(); let c = candidate.clone(); let evidence = evidence.clone();
                    let why = format!("Written within the last {keep_days} days (YN-65 keepDays)");
                    move |s| keep_item(s, &run, seq, &c, None, &evidence, "kept", json!({"code": "keepDays", "why": why})) }).await?;
                summary.kept += 1;
                continue;
            }
            seq += 1;
            let evidence = json!({"rule": candidate.rule, "basis": candidate.basis, "pre": pre.pre.clone()});
            let item_id = ws.stored({ let run = run.clone(); let c = candidate.clone(); let evidence = evidence.clone();
                let pre = pre.pre.clone(); move |s| plan_item(s, &run, seq, &c, None, &evidence, &pre) }).await?;
            ws.stored({ let run = run.clone(); let item = item_id.clone(); move |s| mark_removing(s, &run, &item) }).await?;
            let path_text = candidate.path.to_string_lossy().into_owned();
            let removal = Removal { data: &ws.data_dir, namespace: &run, task: AUTOMATIC, kind: "cache-dir",
                id: &item_id, path: &path_text, pre: &pre.pre };
            let result = execute_checked(ws, &ctx, &removal).await;
            ws.stored({ let run = run.clone(); let item = item_id.clone(); let result = clone_outcome(&result);
                move |s| finish_item(s, &run, &item, &result) }).await?;
            count(&mut summary, &result);
        }
        if let Some(last) = cache.last() {
            ws.stored({ let id = project.id.clone(); let last = key(last); move |s| set_cursor(s, &id, "cache", &last) }).await?;
        }
    }
    let data = json!({"removed": summary.removed, "kept": summary.kept, "tidy": summary.tidy, "failed": summary.failed,
        "incomplete": summary.incomplete});
    ws.stored({ let run = run.clone(); let state = summary.state().to_owned();
        move |s| finish_run(s, &run, &state, data) }).await?;
    Ok(summary)
}

fn clone_outcome(outcome: &Outcome) -> Outcome {
    Outcome { state: outcome.state, result: outcome.result.clone(), snapshot: outcome.snapshot.clone() }
}

fn prepared_outcome(code: &'static str, why: String, record: Option<Value>, snapshot: Option<Value>) -> Outcome {
    let state = match code {
        "partial" => "partial",
        "failed" => "failed",
        _ => "refused",
    };
    let mut result = json!({"code": code, "why": why});
    for (key, value) in record.as_ref().and_then(Value::as_object).into_iter().flatten() {
        result[key] = value.clone();
    }
    Outcome { state, result, snapshot }
}

fn count(summary: &mut Summary, result: &Outcome) {
    match result.state {
        "removed" => summary.removed += 1,
        "partial" | "failed" => summary.failed += 1,
        _ => summary.kept += 1,
    }
}

/// One pass: up to a few Projects, the least recently run first; a pass never
/// runs beside another. Off while both switches are off.
pub(crate) async fn pass(ws: &Arc<Workspace>) -> Result<usize> {
    let Ok(_busy) = ws.cleanup.automatic.try_lock() else { return Ok(0) };
    let (settings, projects) = ws.stored(|s| {
        let db = s.db.read()?;
        Ok((settings::read(&db)?, crate::projects::all(&db)?))
    }).await?;
    if !settings.rule_layer && !settings.worktree_reclaim {
        return Ok(0);
    }
    let mut order: Vec<(Option<String>, crate::projects::Project)> = Vec::new();
    for project in projects.into_iter().filter(|p| p.default_dirs.contains_key("local")) {
        let last: Option<String> = ws.stored({
            let id = project.id.clone();
            move |s| Ok(s.db.read()?.query_row(
                "SELECT MAX(started_at) FROM cleanup_automatic_runs WHERE project_id=?1 AND machine='local'",
                [id], |r| r.get(0)).optional()?.flatten())
        }).await?;
        order.push((last, project));
    }
    order.sort_by(|a, b| a.0.cmp(&b.0));
    order.truncate(PROJECTS_PER_PASS);
    let mut handled = 0;
    for (_, project) in order {
        let Ok(_permit) = ws.admission.enter_work() else { break };
        match project_pass(ws, &settings, &project).await {
            Ok(summary) => handled += summary.removed + summary.kept + summary.tidy,
            Err(error) => eprintln!("[cleanup] automatic pass of Project {} failed: {error:#}", project.name),
        }
    }
    Ok(handled)
}

/// The hourly loop: the first a minute after Core starts, then each hour.
pub(crate) fn start(ws: &Arc<Workspace>) {
    let weak = Arc::downgrade(ws);
    tokio::spawn(async move {
        tokio::time::sleep(FIRST).await;
        loop {
            let Some(ws) = weak.upgrade() else { break };
            if let Err(error) = pass(&ws).await {
                eprintln!("[cleanup] automatic rule layer failed: {error:#}");
            }
            drop(ws);
            tokio::time::sleep(TICK).await;
        }
    });
}

/// One to-tidy entry, deduplicated by Project, machine and path; the oldest
/// beyond the bound go. It is information only.
#[allow(clippy::too_many_arguments)]
fn tidy_row(store: &Store, project: &str, machine: &str, path: &Path, task: Option<&str>, reason: &str, detail: &str, evidence: &Value) -> Result<()> {
    let path = real(path);
    let text = path.to_string_lossy().into_owned();
    let at = now();
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    let meta = std::fs::symlink_metadata(&path).ok();
    let mut head = evidence["head"].as_str().map(str::to_owned);
    if head.is_none() {
        head = evidence["proofs"]["ancestor"]["head"].as_str().map(str::to_owned);
    }
    tx.execute(
        "INSERT INTO cleanup_to_tidy(project_id,machine,path,task_id,reason,detail,first_seen,last_seen,dev,ino,head,head_kind,state)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?7,?8,?9,?10,?11,'open')
         ON CONFLICT(project_id,machine,path) DO UPDATE SET task_id=excluded.task_id,reason=excluded.reason,detail=excluded.detail,
           last_seen=excluded.last_seen,dev=excluded.dev,ino=excluded.ino,head=excluded.head,head_kind=excluded.head_kind,state='open'",
        params![project, machine, text, task, reason, detail, at,
            meta.as_ref().map(|m| m.dev() as i64), meta.as_ref().map(|m| m.ino() as i64),
            head, evidence["proofs"].is_object().then_some("worktree")],
    )?;
    let n: i64 = tx.query_row("SELECT COUNT(*) FROM cleanup_to_tidy", [], |r| r.get(0))?;
    if n > MAX_TIDY {
        tx.execute("DELETE FROM cleanup_to_tidy WHERE (project_id,machine,path) IN
            (SELECT project_id,machine,path FROM cleanup_to_tidy ORDER BY last_seen,path LIMIT ?1)", [(n - MAX_TIDY)])?;
    }
    tx.commit()?;
    Ok(())
}

/// A closed task's recorded folders go to the to-tidy list without any file
/// system or Git work: only paths Core already has. Reopening the task does
/// not turn an old entry into permission to remove anything.
pub(crate) fn note_task_closed(db: &Connection, task: &str) -> Result<()> {
    let project: Option<String> = db.query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [task], |r| r.get(0)).optional()?;
    let Some(project) = project else { return Ok(()) };
    let mut paths: Vec<String> = Vec::new();
    let mut q = db.prepare("SELECT json_extract(data,'$.path') FROM task_workspaces WHERE task_id=?1")?;
    for path in q.query_map([task], |r| r.get::<_, Option<String>>(0))? {
        if let Some(path) = path? {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    let mut q = db.prepare("SELECT json_extract(a.data,'$.cwd') FROM agent_roles r JOIN agents a ON a.id=r.agent_id
        WHERE r.task_id=?1 AND r.kind='executor' AND json_extract(a.data,'$.remote') IS NULL")?;
    for path in q.query_map([task], |r| r.get::<_, Option<String>>(0))? {
        if let Some(path) = path? {
            if !paths.contains(&path) {
                paths.push(path);
            }
        }
    }
    let at = now();
    for path in paths.into_iter().take(200) {
        db.execute(
            "INSERT INTO cleanup_to_tidy(project_id,machine,path,task_id,reason,detail,first_seen,last_seen,state)
             VALUES(?1,'local',?2,?3,'taskClosed','The task closed; its recorded folder is left for the next cleanup to look at',?4,?4,'open')
             ON CONFLICT(project_id,machine,path) DO UPDATE SET last_seen=excluded.last_seen,reason=excluded.reason,state='open'",
            params![project, path, task, at],
        )?;
    }
    let n: i64 = db.query_row("SELECT COUNT(*) FROM cleanup_to_tidy", [], |r| r.get(0))?;
    if n > MAX_TIDY {
        db.execute("DELETE FROM cleanup_to_tidy WHERE (project_id,machine,path) IN
            (SELECT project_id,machine,path FROM cleanup_to_tidy ORDER BY last_seen,path LIMIT ?1)", [(n - MAX_TIDY)])?;
    }
    Ok(())
}

/// The to-tidy list of one Project and machine, for a cleanup dispatch's
/// materials: bounded, with the total and where to read on.
pub(crate) fn tidy_snapshot(db: &Connection, project: &str, machine: &str, limit: usize) -> Result<Value> {
    let total: i64 = db.query_row("SELECT COUNT(*) FROM cleanup_to_tidy WHERE project_id=?1 AND machine=?2",
        params![project, machine], |r| r.get(0))?;
    let mut q = db.prepare(
        "SELECT path,task_id,reason,detail,first_seen,last_seen,dev,ino,head,head_kind,state
         FROM cleanup_to_tidy WHERE project_id=?1 AND machine=?2 ORDER BY path LIMIT ?3",
    )?;
    let items: Vec<Value> = q
        .query_map(params![project, machine, limit as i64], |r| {
            Ok(json!({"path": r.get::<_, String>(0)?, "taskId": r.get::<_, Option<String>>(1)?,
                "reason": r.get::<_, String>(2)?, "detail": r.get::<_, Option<String>>(3)?,
                "firstSeen": r.get::<_, String>(4)?, "lastSeen": r.get::<_, String>(5)?,
                "dev": r.get::<_, Option<i64>>(6)?, "ino": r.get::<_, Option<i64>>(7)?, "head": r.get::<_, Option<String>>(8)?,
                "headKind": r.get::<_, Option<String>>(9)?, "state": r.get::<_, String>(10)?}))
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(json!({"projectId": project, "machine": machine, "total": total, "returned": items.len(),
        "items": items, "hasMore": total > items.len() as i64,
        "readWith": "cleanup_tidy_get(taskId=<this task>, after=<the last path>, limit=50)",
        "note": "Information only: no entry authorizes a removal. Commits of its own, a git cherry question, a snapshot over the limit and a closed task's folders wait for a cleanup executor."}))
}

pub(crate) fn tidy_definition() -> Value {
    json!({"name":"cleanup_tidy_get",
        "description":"Read the Core-owned to-tidy list for your task's Project on this Core's host: worktrees a cleanup could not decide (commits of its own, only git cherry could tell, a snapshot over the limit, an unknown Git answer) and folders of a closed task, with why and when each was seen. It authorizes nothing: it is information for your plan, and only the user's approval of a plan removes anything. Requires taskId of your own task; a lead of its Project or the user may read it too. Page with after (the last path returned) and limit (1 to 100, default 20).",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["taskId"],"properties":{
            "taskId":{"type":"string","description":collaboration::TASK_ID},
            "after":{"type":"string","maxLength":4096},
            "limit":{"type":"integer","minimum":1,"maximum":100,"default":20}}}})
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(Clone)]
pub(crate) struct TidyInput {
    task_id: String,
    #[serde(default)]
    after: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
}

pub(crate) async fn tidy_get(ws: &Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    let input: TidyInput = serde_json::from_value(input).map_err(|e| anyhow::anyhow!("invalid_input: {e}"))?;
    let limit = input.limit.unwrap_or(20).clamp(1, 100);
    let answer = ws.stored({
        let input = input.clone();
        move |s| {
            let db = s.db.read()?;
            let (task, _) = collaboration::task_key(&db, &input.task_id)?;
            if let Some(actor) = actor.as_deref() {
                let own: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM agent_roles WHERE agent_id=?1 AND kind='executor' AND task_id=?2 AND archived_at IS NULL)",
                    params![actor, task], |r| r.get(0))?;
                let project: Option<String> = db.query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&task], |r| r.get(0)).optional()?;
                let lead = match project.as_deref() { Some(p) => crate::agent_roles::leads(&db, actor, p)?, None => false };
                ensure!(own || lead, "not_allowed: only a task's own executor, a lead of its Project or the user reads its to-tidy list");
            }
            let project: Option<String> = db.query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&task], |r| r.get(0)).optional()?;
            let project = project.context("no_project: the task is in no Project")?;
            let total: i64 = db.query_row("SELECT COUNT(*) FROM cleanup_to_tidy WHERE project_id=?1 AND machine='local'", [&project], |r| r.get(0))?;
            let after = input.after.as_deref().unwrap_or("");
            let mut q = db.prepare(
                "SELECT path,task_id,reason,detail,first_seen,last_seen,dev,ino,head,head_kind,state
                 FROM cleanup_to_tidy WHERE project_id=?1 AND machine='local' AND path>?2 ORDER BY path LIMIT ?3",
            )?;
            let items: Vec<Value> = q
                .query_map(params![project, after, limit as i64 + 1], |r| Ok(json!({"path": r.get::<_, String>(0)?,
                    "taskId": r.get::<_, Option<String>>(1)?, "reason": r.get::<_, String>(2)?, "detail": r.get::<_, Option<String>>(3)?,
                    "firstSeen": r.get::<_, String>(4)?, "lastSeen": r.get::<_, String>(5)?, "dev": r.get::<_, Option<i64>>(6)?,
                    "ino": r.get::<_, Option<i64>>(7)?, "head": r.get::<_, Option<String>>(8)?, "headKind": r.get::<_, Option<String>>(9)?,
                    "state": r.get::<_, String>(10)?})))?
                .collect::<rusqlite::Result<_>>()?;
            let more = items.len() > limit;
            let items: Vec<Value> = items.into_iter().take(limit).collect();
            Ok(json!({"projectId": project, "machine": "local", "total": total, "items": items,
                "hasMore": more, "nextAfter": items.last().map(|i| i["path"].clone()),
                "note": "Information only: no entry authorizes a removal."}))
        }
    }).await?;
    Ok(answer)
}

