//! Which queued jobs admission tries, in what order. One queue, bounded and
//! explainable: jobs waiting longer than `AGING` go first, oldest first; the
//! rest take turns by project (a task's Project, else its Agent's, else the
//! Agent), starting after the project served last, each project's jobs oldest
//! first. A queued exclusive job keeps its FIFO barrier: nothing submitted
//! after it is a candidate, and it comes after everything submitted before it.
//! The order only decides who is tried first; whether a job may pass another
//! that is waiting is decided by the admission scan (store.rs).
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// A job queued this long is tried before the project rotation.
pub(super) const AGING_SECS: i64 = 30 * 60;
/// At most this many candidates are tried per admission.
pub(super) const WINDOW: usize = 32;

#[derive(Clone, Debug)]
pub(super) struct Queued {
    pub id: String,
    pub seq: i64,
    pub project: String,
    pub waited_secs: i64,
    pub exclusive: bool,
    pub cwd: String,
}

/// Indexes into `queued` (which is in submission order), in admission order.
pub(super) fn order(queued: &[Queued], last_project: Option<&str>) -> Vec<usize> {
    let barrier = queued.iter().filter(|q| q.exclusive).map(|q| q.seq).min();
    let mut aged = Vec::new();
    let mut by_project: BTreeMap<&str, Vec<usize>> = BTreeMap::new();
    let mut exclusive = None;
    for (index, job) in queued.iter().enumerate() {
        match barrier {
            Some(seq) if job.seq > seq => continue,
            Some(seq) if job.seq == seq => {
                exclusive = Some(index);
                continue;
            }
            _ => {}
        }
        if job.waited_secs >= AGING_SECS {
            aged.push(index);
        } else {
            by_project
                .entry(job.project.as_str())
                .or_default()
                .push(index);
        }
    }
    aged.sort_by_key(|&i| queued[i].seq);
    let mut order = aged;
    // Projects in key order, starting after the one served last.
    let mut projects: Vec<&str> = by_project.keys().copied().collect();
    if let Some(last) = last_project {
        let start = projects.iter().position(|p| *p > last).unwrap_or(0);
        projects.rotate_left(start);
    }
    let mut queues: Vec<std::collections::VecDeque<usize>> = projects
        .iter()
        .map(|p| {
            let mut jobs = by_project[p].clone();
            jobs.sort_by_key(|&i| queued[i].seq);
            jobs.into()
        })
        .collect();
    while queues.iter().any(|q| !q.is_empty()) {
        for queue in &mut queues {
            if let Some(index) = queue.pop_front() {
                order.push(index);
            }
        }
    }
    order.extend(exclusive);
    order.truncate(WINDOW);
    order
}

/// Every queued job, in submission order, with its project key. A service's
/// automatic retry whose delay has not passed (`notBeforeUnix`, T-14) is left
/// out here, before `order` takes a window: it neither holds a place nor
/// keeps others out.
pub(super) fn queued(db: &Connection) -> Result<Vec<Queued>> {
    let mut q = db.prepare(
        "SELECT j.id, j.seq, COALESCE(pt.project_id, pa.project_id, 'agent:' || j.agent_id),
                json_extract(j.data,'$.createdAt'), COALESCE(json_extract(j.data,'$.exclusive'),0),
                COALESCE(json_extract(j.data,'$.cwd'),'')
         FROM local_jobs j
         LEFT JOIN project_tasks pt ON pt.task_id=j.task_id
         LEFT JOIN project_agents pa ON pa.agent_id=j.agent_id
         WHERE j.status='queued' AND json_extract(j.data,'$.executor') IS NULL
           AND COALESCE(json_extract(j.data,'$.notBeforeUnix'),0) <= ?1 ORDER BY j.seq",
    )?;
    let now = chrono::Utc::now();
    let unix = now.timestamp_millis() as f64 / 1000.0;
    let rows = q
        .query_map([unix], |r| {
            let created: Option<String> = r.get(3)?;
            let waited = created
                .and_then(|c| chrono::DateTime::parse_from_rfc3339(&c).ok())
                .map(|c| (now - c.with_timezone(&chrono::Utc)).num_seconds())
                .unwrap_or(0);
            Ok(Queued {
                id: r.get(0)?,
                seq: r.get(1)?,
                project: r.get(2)?,
                waited_secs: waited,
                exclusive: r.get::<_, i64>(4)? != 0,
                cwd: r.get(5)?,
            })
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS local_job_queue_state(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);",
    )?;
    Ok(())
}

pub(super) fn last_project(db: &Connection) -> Result<Option<String>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM local_job_queue_state WHERE id=1",
            [],
            |r| r.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|r| serde_json::from_str::<Value>(&r).ok())
        .and_then(|v| v["lastProject"].as_str().map(str::to_owned)))
}

pub(super) fn served(db: &Connection, project: &str) -> Result<()> {
    db.execute(
        "INSERT INTO local_job_queue_state(id,data) VALUES(1,?1) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
        [json!({"lastProject":project}).to_string()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn job(id: &str, seq: i64, project: &str, waited: i64, exclusive: bool) -> Queued {
        Queued {
            id: id.into(),
            seq,
            project: project.into(),
            waited_secs: waited,
            exclusive,
            cwd: "/w".into(),
        }
    }
    fn ids(queued: &[Queued], order: &[usize]) -> Vec<String> {
        order.iter().map(|&i| queued[i].id.clone()).collect()
    }

    #[test]
    fn projects_take_turns_oldest_first_starting_after_the_last_served() {
        let q = vec![
            job("a1", 1, "A", 0, false),
            job("a2", 2, "A", 0, false),
            job("a3", 3, "A", 0, false),
            job("b1", 4, "B", 0, false),
            job("c1", 5, "C", 0, false),
        ];
        assert_eq!(ids(&q, &order(&q, None)), ["a1", "b1", "c1", "a2", "a3"]);
        assert_eq!(
            ids(&q, &order(&q, Some("A"))),
            ["b1", "c1", "a1", "a2", "a3"]
        );
        assert_eq!(
            ids(&q, &order(&q, Some("C"))),
            ["a1", "b1", "c1", "a2", "a3"]
        );
    }

    #[test]
    fn a_job_waiting_past_the_aging_limit_goes_first() {
        let q = vec![
            job("a1", 1, "A", AGING_SECS + 5, false),
            job("a2", 2, "A", AGING_SECS, false),
            job("b1", 3, "B", 10, false),
        ];
        assert_eq!(ids(&q, &order(&q, Some("Z"))), ["a1", "a2", "b1"]);
    }

    #[test]
    fn a_queued_exclusive_job_keeps_its_fifo_barrier_and_comes_last() {
        let q = vec![
            job("a1", 1, "A", 0, false),
            job("x", 2, "B", AGING_SECS * 2, true),
            job("b1", 3, "B", AGING_SECS * 2, false),
            job("c1", 4, "C", 0, false),
        ];
        assert_eq!(ids(&q, &order(&q, None)), ["a1", "x"]);
    }

    #[test]
    fn the_window_is_bounded() {
        let q: Vec<_> = (0..50)
            .map(|n| job(&format!("j{n}"), n, "A", 0, false))
            .collect();
        assert_eq!(order(&q, None).len(), WINDOW);
    }
}
