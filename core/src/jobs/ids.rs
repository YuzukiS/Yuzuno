//! A Job or run named by its whole ID or by a unique prefix of it (T-30).
//!
//! Core gives each Job and run a UUID; mail and notes name them by their
//! first eight characters. job_get, job_logs, job_cancel and job_provenance
//! (jobId and runId), and job_run_get, job_run_decide, job_run_retry and
//! job_run_cancel (YN-30), take either: the whole ID, as before, or at least
//! MIN_PREFIX hexadecimal characters from its start (with its hyphens where
//! it has them), which must name exactly one. A prefix that names none or
//! several says so and never lists the IDs it matched. A decision or retry
//! is kept with the whole run ID, so its repeat is the same request however
//! either names the run. The other Jobs tools that name a Job, such as
//! job_pause, still take the whole ID. IDs are made and stored as before.
use crate::store::Store;
use anyhow::{bail, ensure, Result};
use rusqlite::{Connection, OptionalExtension};

/// The fewest hexadecimal characters a prefix may have: a UUID's first group.
pub(super) const MIN_PREFIX: usize = 8;

/// What an ID names, and so which table it is looked up in.
#[derive(Clone, Copy)]
pub(super) enum Kind {
    Job,
    Run,
}
impl Kind {
    fn table(self) -> &'static str {
        match self {
            Kind::Job => "local_jobs",
            Kind::Run => "local_job_runs",
        }
    }
    fn noun(self) -> &'static str {
        match self {
            Kind::Job => "Job",
            Kind::Run => "Run",
        }
    }
}

/// The whole ID `given` names: itself when it is one, else the one ID that
/// starts with it. "not found" and "ambiguous" are told apart, and neither
/// names another ID.
pub(super) fn resolve(db: &Connection, kind: Kind, given: &str) -> Result<String> {
    let (table, noun) = (kind.table(), kind.noun());
    if db.query_row(&format!("SELECT 1 FROM {table} WHERE id=?1"), [given], |_| Ok(())).optional()?.is_some() {
        return Ok(given.to_owned());
    }
    let prefix = given.trim().to_ascii_lowercase();
    ensure!(
        prefix.chars().all(|c| c.is_ascii_hexdigit() || c == '-'),
        "{noun} not found: {given:?} is neither a {noun} ID nor the start of one"
    );
    let hex = prefix.chars().filter(char::is_ascii_hexdigit).count();
    ensure!(
        hex >= MIN_PREFIX,
        "{noun} ID prefix {prefix:?} is too short: give at least {MIN_PREFIX} of its hexadecimal characters, or the whole ID"
    );
    let (matches, id): (i64, Option<String>) = db.query_row(
        &format!("SELECT COUNT(*), MIN(id) FROM {table} WHERE substr(id, 1, length(?1)) = ?1"),
        [&prefix],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    match (matches, id) {
        (1, Some(id)) => Ok(id),
        (0, _) => bail!("{noun} not found: no {noun} ID starts with {prefix:?}"),
        (n, _) => bail!("{noun} ID prefix {prefix:?} is ambiguous ({n} matches): give more of it, or the whole ID"),
    }
}

impl Store {
    /// `resolve`, on a read of its own.
    pub(super) fn resolve_id(&self, kind: Kind, given: &str) -> Result<String> {
        let db = self.db.read()?;
        resolve(&db, kind, given)
    }
}
