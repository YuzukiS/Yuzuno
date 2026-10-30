//! Which Brief version last wrote each section (T-9 section-level CAS), so
//! that `brief_update` refuses a stale write to a section, not every write
//! made after any other section changed.
//!
//! Only Agent writes are recorded (put, edit, resolve, remove, claim: the
//! keys `apply` changes, in the transaction that changes them). Home's
//! replies, Seen and deferrals are not writes, and never moved the Brief's
//! version either. Every Project has one base row: keys without a row of
//! their own were last written at or before its version. The record is
//! trusted only while its newest row is the Brief's version, which every
//! recorded write leaves true; otherwise (no record yet, or the Brief moved
//! on without one) an update is checked against the whole Brief, and its
//! write starts the record afresh.
use super::*;

/// The base row's key, which no section can have (see update::valid_key).
const BASE: &str = "";

/// A change whose section was written after the version read: by its index
/// in the update, the Brief version that wrote it, or None when Core's
/// record does not go back that far.
pub(super) type Stale = (usize, Option<i64>);

/// The changes of `keys` whose section was written after Brief version
/// `expected`, with the Brief at `current`. None when the record of this
/// Project's writes can't say, so the whole Brief decides.
pub(super) fn stale(db: &Connection, project: &str, current: i64, expected: i64, keys: &[&str]) -> Result<Option<Vec<Stale>>> {
    let Some(base) = trusted_base(db, project, current)? else { return Ok(None) };
    let mut found = vec![];
    for (index, key) in keys.iter().enumerate() {
        let written: Option<i64> = db
            .query_row("SELECT version FROM project_brief_writes WHERE project_id=?1 AND key=?2", params![project, key], |r| r.get(0))
            .optional()?;
        match written {
            Some(version) if version > expected => found.push((index, Some(version))),
            Some(_) => {}
            // Last written at or before the base: after `expected` for all Core knows.
            None if expected < base => found.push((index, None)),
            None => {}
        }
    }
    Ok(Some(found))
}

/// The base version, when the record covers every write up to `current`.
fn trusted_base(db: &Connection, project: &str, current: i64) -> Result<Option<i64>> {
    let (base, newest): (Option<i64>, Option<i64>) = db.query_row(
        "SELECT (SELECT version FROM project_brief_writes WHERE project_id=?1 AND key=?2),
         (SELECT MAX(version) FROM project_brief_writes WHERE project_id=?1)",
        params![project, BASE],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(base.filter(|_| newest == Some(current)))
}

/// Records that the Brief's write from `before` to `version` changed `keys`.
/// An untrusted record starts afresh from `before`: only an update checked
/// against the whole Brief at `before` gets this far then.
pub(super) fn record(tx: &Connection, project: &str, before: i64, version: i64, keys: &[&str]) -> Result<()> {
    if trusted_base(tx, project, before)?.is_none() {
        tx.execute("DELETE FROM project_brief_writes WHERE project_id=?1", [project])?;
        tx.execute("INSERT INTO project_brief_writes(project_id,key,version) VALUES(?1,?2,?3)", params![project, BASE, before])?;
    }
    for key in keys {
        tx.execute(
            "INSERT INTO project_brief_writes(project_id,key,version) VALUES(?1,?2,?3)
             ON CONFLICT(project_id,key) DO UPDATE SET version=excluded.version",
            params![project, key, version],
        )?;
    }
    Ok(())
}
