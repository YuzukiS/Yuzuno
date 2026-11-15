//! The Job history at its limit (YN-142). When a new Job would make more
//! than `LIMIT` records, the oldest finished ones nothing uses any more are
//! removed in the same transaction as the insert, down to `TARGET`; the new
//! Job is refused only when not enough of them can go, and then nothing is
//! removed.
//!
//! What is removed is a unit: a Job outside every run, or a whole run (its
//! record, its attempt rows and every attempt's Job together). A unit stays
//! whole while any part of it is held:
//! - a Job not finished, or still holding a reservation;
//! - a stage stopped at a checkpoint the user may still resume;
//! - a Job linked to a registered service (`service_jobs::live` reads a
//!   missing one as possibly still serving);
//! - the inventory Job of a cleanup plan;
//! - a Job a result, a research record or review evidence of an open task
//!   cites (open: not done, not cancelled, not archived), whose citation reads
//!   it again (`result_outcome::resolve`);
//! - a run not settled, or one an unsettled run waits for (`afterRuns`);
//! - a Job a stage of any run still present reuses (`reusedFrom.jobId`):
//!   the run's analysis gate and the artifacts a waiting run leaves out of
//!   its guard read it again (`runs/analysis.rs`, `runs/after.rs declared`);
//! - what the caller names (`Keep`): the run a retry adds to, the runs a new
//!   run waits for, the Job it reuses.
//!
//! Oldest means finished first (a run: settled first), not submitted first.
//! The request that named a removed Job stays, so its requestId never makes a
//! second Job. Each task's removed attempts and runs are counted for job_cost,
//! and the removed Jobs' own folders are removed after the commit by the job
//! loop (`remove_folders`), only those.
use super::store::get;
use crate::store::Store;
use anyhow::{bail, ensure, Result};
use rusqlite::{params, Connection, OptionalExtension};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::Path,
};

/// The most Job records kept: the limit Core has refused new Jobs at since
/// local Jobs began (store.rs, runs.rs), and the most attempts job_cost reads.
pub(crate) const LIMIT: i64 = 5000;
/// Where a removal stops: a tenth of the limit at a time, so the reference
/// scan runs at most once every 500 new Jobs while nine tenths are kept.
pub(super) const TARGET: i64 = 4500;
const FINISHED: &str = "'succeeded','failed','cancelled','rejected','interrupted'";

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "-- What each task lost to removal, for job_cost (YN-142).
        CREATE TABLE IF NOT EXISTS local_job_history_pruned(task_id TEXT PRIMARY KEY,
            jobs INTEGER NOT NULL, runs INTEGER NOT NULL, last_at TEXT NOT NULL);
        -- Removed Jobs whose folder the job loop has not removed yet.
        CREATE TABLE IF NOT EXISTS local_job_pruned_folders(job_id TEXT PRIMARY KEY);",
    )?;
    Ok(())
}

/// What the caller's own write still needs, beside what is held anyway.
#[derive(Default)]
pub(super) struct Keep {
    pub runs: Vec<String>,
    pub jobs: Vec<String>,
}

/// Room for `adding` new Job records in this transaction: removes the oldest
/// finished units nothing holds when the history would pass `LIMIT`. Atomic
/// on its own (a savepoint), so a caller that goes on after a refusal never
/// commits half a removal.
pub(super) fn make_room(tx: &Connection, adding: i64, keep: &Keep) -> Result<()> {
    let count: i64 = tx.query_row("SELECT COUNT(*) FROM local_jobs", [], |r| r.get(0))?;
    if count + adding <= LIMIT {
        return Ok(());
    }
    tx.execute_batch("SAVEPOINT job_history_prune")?;
    match prune(tx, count, adding, keep) {
        Ok(()) => {
            tx.execute_batch("RELEASE job_history_prune")?;
            Ok(())
        }
        Err(error) => {
            tx.execute_batch("ROLLBACK TO job_history_prune; RELEASE job_history_prune")?;
            Err(error)
        }
    }
}

/// Why a Job stays, in the order a refusal counts them.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
enum Held {
    Unfinished,
    Checkpoint,
    Service,
    Inventory,
    Cited,
    Reused,
    Run,
    Caller,
}

/// One removable unit: its time and seq, its run and that run's task, and
/// each Job with its task.
struct Unit {
    at: (i64, i64),
    run: Option<(String, String)>,
    jobs: Vec<(String, String)>,
}

struct Plan {
    units: Vec<Unit>,
    held: BTreeMap<Held, i64>,
}

fn prune(tx: &Connection, count: i64, adding: i64, keep: &Keep) -> Result<()> {
    let need = count + adding - LIMIT;
    let want = need.max(count - TARGET);
    let plan = plan(tx, keep)?;
    let (mut chosen, mut freed) = (Vec::new(), 0i64);
    for unit in plan.units {
        if freed >= want {
            break;
        }
        freed += unit.jobs.len() as i64;
        chosen.push(unit);
    }
    if freed < need {
        let held = |kind| plan.held.get(&kind).copied().unwrap_or(0);
        bail!(
            "Local job history is full ({LIMIT}) and too few finished Jobs can be removed to make room, so nothing was removed or queued: \
             {} unfinished or holding resources, {} stopped at a checkpoint that can be resumed, {} linked to a service, \
             {} a cleanup plan's inventory, {} cited by an open task's result, research or review evidence, \
             {} reused by a run's stage, {} in a run not settled or one a run waits for. \
             Let them finish, settle or close those tasks, runs or services, then submit again",
            held(Held::Unfinished), held(Held::Checkpoint), held(Held::Service),
            held(Held::Inventory), held(Held::Cited), held(Held::Reused), held(Held::Run) + held(Held::Caller)
        );
    }
    let before = Checks::read(tx)?;
    let at = crate::model::now();
    let mut tally: HashMap<String, (i64, i64)> = HashMap::new();
    for unit in &chosen {
        if let Some((run, task)) = &unit.run {
            tx.execute("DELETE FROM local_job_run_attempts WHERE run_id=?1", [run])?;
            tx.execute("DELETE FROM local_job_runs WHERE id=?1", [run])?;
            tally.entry(task.clone()).or_default().1 += 1;
        }
        for (job, task) in &unit.jobs {
            tx.execute("DELETE FROM local_jobs WHERE id=?1", [job])?;
            tx.execute("INSERT OR IGNORE INTO local_job_pruned_folders(job_id) VALUES(?1)", [job])?;
            tally.entry(task.clone()).or_default().0 += 1;
        }
    }
    for (task, (jobs, runs)) in tally {
        tx.execute(
            "INSERT INTO local_job_history_pruned(task_id,jobs,runs,last_at) VALUES(?1,?2,?3,?4)
             ON CONFLICT(task_id) DO UPDATE SET jobs=jobs+excluded.jobs, runs=runs+excluded.runs, last_at=excluded.last_at",
            params![task, jobs, runs, at],
        )?;
    }
    let after = Checks::read(tx)?;
    ensure!(
        after.jobs == before.jobs - freed
            && after.unfinished == before.unfinished
            && after.orphan_attempts <= before.orphan_attempts
            && after.missing_after_runs <= before.missing_after_runs
            && after.missing_service_jobs <= before.missing_service_jobs,
        "Job history removal did not check out, so nothing was removed or queued: before {before:?}, after {after:?}, removing {freed}"
    );
    Ok(())
}

/// What a removal must leave as it was: checked before and after it.
#[derive(Debug)]
struct Checks {
    jobs: i64,
    unfinished: i64,
    orphan_attempts: i64,
    missing_after_runs: i64,
    missing_service_jobs: i64,
}

impl Checks {
    fn read(db: &Connection) -> Result<Self> {
        let count = |sql: &str| db.query_row(sql, [], |r| r.get::<_, i64>(0));
        Ok(Self {
            jobs: count("SELECT COUNT(*) FROM local_jobs")?,
            unfinished: count(&format!(
                "SELECT COUNT(*) FROM local_jobs WHERE status NOT IN ({FINISHED}) OR reserved<>0"
            ))?,
            orphan_attempts: count(
                "SELECT COUNT(*) FROM local_job_run_attempts a WHERE NOT EXISTS(SELECT 1 FROM local_jobs j WHERE j.id=a.job_id)",
            )?,
            missing_after_runs: count(
                "SELECT COUNT(*) FROM local_job_runs r, json_each(r.data,'$.afterRuns') a
                 WHERE json_extract(r.data,'$.settledAt') IS NULL
                   AND NOT EXISTS(SELECT 1 FROM local_job_runs o WHERE o.id=json_extract(a.value,'$.runId'))",
            )?,
            missing_service_jobs: count(
                "SELECT COUNT(*) FROM project_service_jobs l WHERE NOT EXISTS(SELECT 1 FROM local_jobs j WHERE j.id=l.job_id)",
            )?,
        })
    }
}

/// Seconds and nanoseconds of an RFC 3339 time; an unreadable one is the
/// newest, so it goes last.
fn when(at: Option<String>) -> i64 {
    at.and_then(|at| chrono::DateTime::parse_from_rfc3339(&at).ok())
        .and_then(|at| at.timestamp_nanos_opt())
        .unwrap_or(i64::MAX)
}

fn ids(db: &Connection, sql: &str) -> Result<HashSet<String>> {
    let mut q = db.prepare(sql)?;
    let rows = q.query_map([], |r| r.get::<_, Option<String>>(0))?;
    let mut out = HashSet::new();
    for row in rows {
        if let Some(id) = row? {
            out.insert(id);
        }
    }
    Ok(out)
}

/// The Jobs a citation of an open task names: a result's artifacts, a
/// research record's sources and review evidence, wherever they say jobId.
const CITED: &str = "SELECT t.value FROM collaboration_tasks c
     JOIN collaboration_task_activity a ON a.task_id=c.id
     JOIN json_tree(a.data) t
     WHERE COALESCE(json_extract(c.data,'$.status'),'') NOT IN ('done','cancelled')
       AND json_extract(c.data,'$.archivedAt') IS NULL
       AND (json_extract(a.data,'$.kind')='result' OR json_type(a.data,'$.research')='object')
       AND instr(a.data,'\"jobId\"')>0 AND t.key='jobId' AND t.type='text'
     UNION
     SELECT t.value FROM collaboration_tasks c
     JOIN pr_review_evidence e ON e.task_id=c.id
     JOIN json_tree(e.data) t
     WHERE COALESCE(json_extract(c.data,'$.status'),'') NOT IN ('done','cancelled')
       AND json_extract(c.data,'$.archivedAt') IS NULL
       AND instr(e.data,'\"jobId\"')>0 AND t.key='jobId' AND t.type='text'";

fn plan(db: &Connection, keep: &Keep) -> Result<Plan> {
    let service = ids(db, "SELECT job_id FROM project_service_jobs")?;
    let inventory = ids(db, "SELECT job_id FROM cleanup_inventories WHERE job_id IS NOT NULL")?;
    let cited = ids(db, CITED)?;
    let reused = ids(
        db,
        "SELECT json_extract(s.value,'$.reusedFrom.jobId') FROM local_job_runs r, json_each(r.data,'$.stages') s
         WHERE json_type(s.value,'$.reusedFrom')='object'",
    )?;
    let caller_jobs: HashSet<&str> = keep.jobs.iter().map(String::as_str).collect();
    // Each Job: its unit's time and task, and why it stays, if it does.
    struct Job {
        seq: i64,
        task: String,
        at: i64,
        held: Option<Held>,
    }
    let mut jobs: HashMap<String, Job> = HashMap::new();
    {
        let mut q = db.prepare(&format!(
            "SELECT id, seq, task_id, status NOT IN ({FINISHED}) OR reserved<>0 OR COALESCE(json_extract(data,'$.reserved'),0)<>0,
                status='cancelled' AND json_extract(data,'$.checkpointStop.state')='checkpointed'
                    AND json_extract(data,'$.checkpointStop.resumedAs') IS NULL,
                COALESCE(json_extract(data,'$.finishedAt'), json_extract(data,'$.createdAt'))
             FROM local_jobs"
        ))?;
        let rows = q.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?,
                r.get::<_, bool>(4)?, r.get::<_, Option<String>>(5)?))
        })?;
        for row in rows {
            let (id, seq, task, unfinished, checkpoint, at) = row?;
            let held = if unfinished {
                Some(Held::Unfinished)
            } else if checkpoint {
                Some(Held::Checkpoint)
            } else if service.contains(&id) {
                Some(Held::Service)
            } else if inventory.contains(&id) {
                Some(Held::Inventory)
            } else if cited.contains(&id) {
                Some(Held::Cited)
            } else if reused.contains(&id) {
                Some(Held::Reused)
            } else if caller_jobs.contains(id.as_str()) {
                Some(Held::Caller)
            } else {
                None
            };
            jobs.insert(id, Job { seq, task, at: when(at), held });
        }
    }
    // Runs: each with its attempts' Jobs, settled or not, and those waited for.
    let mut members: HashMap<String, Vec<String>> = HashMap::new();
    let mut in_run: HashSet<String> = HashSet::new();
    {
        let mut q = db.prepare("SELECT run_id, job_id FROM local_job_run_attempts ORDER BY run_id, stage, attempt")?;
        for row in q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (run, job) = row?;
            in_run.insert(job.clone());
            members.entry(run).or_default().push(job);
        }
    }
    let awaited = ids(
        db,
        "SELECT json_extract(a.value,'$.runId') FROM local_job_runs r, json_each(r.data,'$.afterRuns') a
         WHERE json_extract(r.data,'$.settledAt') IS NULL",
    )?;
    let caller_runs: HashSet<&str> = keep.runs.iter().map(String::as_str).collect();
    let mut units = Vec::new();
    let mut held: BTreeMap<Held, i64> = BTreeMap::new();
    {
        let mut q = db.prepare("SELECT id, seq, task_id, json_extract(data,'$.settledAt') FROM local_job_runs")?;
        let rows = q.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?))
        })?;
        for row in rows {
            let (run, seq, task, settled) = row?;
            let Some(attempts) = members.remove(&run) else { continue };
            let present: Vec<&String> = attempts.iter().filter(|id| jobs.contains_key(*id)).collect();
            let inner = present.iter().filter_map(|id| jobs[*id].held).min();
            let run_held = settled.is_none() || awaited.contains(&run) || caller_runs.contains(run.as_str());
            if inner.is_some() || run_held {
                // Counted by each Job's own reason, else as held by its run.
                for id in &present {
                    let reason = jobs[*id].held.unwrap_or(if caller_runs.contains(run.as_str()) { Held::Caller } else { Held::Run });
                    *held.entry(reason).or_default() += 1;
                }
                continue;
            }
            let members = present.iter().map(|id| ((*id).clone(), jobs[*id].task.clone())).collect();
            units.push(Unit { at: (when(settled), seq), run: Some((run, task)), jobs: members });
        }
    }
    // Attempt rows of a run Core no longer has: their Jobs stay with them.
    for attempts in members.into_values() {
        for id in attempts.iter().filter(|id| jobs.contains_key(*id)) {
            *held.entry(jobs[id].held.unwrap_or(Held::Run)).or_default() += 1;
        }
    }
    for (id, job) in &jobs {
        if in_run.contains(id) {
            continue;
        }
        match job.held {
            Some(reason) => *held.entry(reason).or_default() += 1,
            None => units.push(Unit { at: (job.at, job.seq), run: None, jobs: vec![(id.clone(), job.task.clone())] }),
        }
    }
    units.sort_by_key(|unit| unit.at);
    Ok(Plan { units, held })
}

impl Store {
    /// Removed Jobs whose folder is not removed yet, a bounded batch.
    pub(super) fn pruned_folders(&self) -> Result<Vec<String>> {
        let db = self.db.read()?;
        let mut q = db.prepare("SELECT job_id FROM local_job_pruned_folders ORDER BY job_id LIMIT 1000")?;
        let ids = q.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(ids)
    }
    pub(super) fn forget_pruned_folders(&self, ids: &[String]) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        for id in ids {
            tx.execute("DELETE FROM local_job_pruned_folders WHERE job_id=?1", [id])?;
        }
        tx.commit()?;
        Ok(())
    }
    /// A task's attempts and runs removed from the history (job_cost).
    pub(super) fn pruned_of(db: &Connection, task: &str) -> Result<(i64, i64)> {
        Ok(db
            .query_row("SELECT jobs, runs FROM local_job_history_pruned WHERE task_id=?1", [task], |r| Ok((r.get(0)?, r.get(1)?)))
            .optional()?
            .unwrap_or((0, 0)))
    }
}

/// Removes the folder of each removed Job named here, only `<data>/jobs/<id>`
/// with `id` a Job's own UUID and only a real folder there: a link or any
/// other file is left as it is. Each one is settled, removed or not; a
/// failure is only logged. Returns the IDs handled.
pub(super) fn remove_folders_in(data: &Path, ids: &[String]) -> Vec<String> {
    let root = data.join("jobs");
    for id in ids {
        let canonical = uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.hyphenated().to_string() == *id);
        if !canonical {
            eprintln!("Job history: not removing the folder of {id:?}: not a Job's UUID");
            continue;
        }
        let path = root.join(id);
        if path.parent() != Some(root.as_path()) {
            eprintln!("Job history: not removing {}: not directly in {}", path.display(), root.display());
            continue;
        }
        match std::fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => eprintln!("Job history: cannot read {}: {error}", path.display()),
            Ok(meta) if meta.is_dir() => {
                if let Err(error) = std::fs::remove_dir_all(&path) {
                    eprintln!("Job history: cannot remove {}: {error}", path.display());
                }
            }
            Ok(_) => eprintln!("Job history: not removing {}: not a folder (a link is not followed)", path.display()),
        }
    }
    ids.to_vec()
}

/// The job loop's part: the folders of the Jobs a committed removal took.
pub(super) async fn remove_folders(ws: &std::sync::Arc<crate::workspace::Workspace>) -> Result<()> {
    let ids = ws.stored(|s| s.pruned_folders()).await?;
    if ids.is_empty() {
        return Ok(());
    }
    let data = ws.data_dir.clone();
    let done = tokio::task::spawn_blocking(move || remove_folders_in(&data, &ids)).await?;
    ws.stored(move |s| s.forget_pruned_folders(&done)).await
}

/// A replayed requestId whose Job was removed: said as such, never a new Job.
pub(super) fn replayed(db: &Connection, id: &str) -> Result<serde_json::Value> {
    let exists: Option<i64> = db.query_row("SELECT 1 FROM local_jobs WHERE id=?1", [id], |r| r.get(0)).optional()?;
    ensure!(
        exists.is_some(),
        "This requestId named Job {id}, which was removed from the Job history (the oldest finished Jobs are removed when it reaches {LIMIT}); submit again with a new requestId"
    );
    get(db, id)
}
