//! Rolling CI history (R-39). What Core monitors now, and what ended in the
//! last KEEP_SECONDS, stays in the main CI tables, which the monitor reads
//! every few seconds. An older ended watch moves into their archive as one
//! unit: the watch, its subscriptions with their interests and completion
//! receipts, its run links, and those of its runs no other main watch links.
//! Readers look in both (`Place`). A new subscription to an archived watch,
//! or a new observation of an archived run, moves it back first, receipts
//! and all, so each completion is still mailed once to each subscription.
//!
//! A watch moves once all of this holds, each pass checking it again:
//! - none of its subscriptions or interests is active (an expired one is
//!   closed by the lifecycle first, with its notices);
//! - the last of them ended KEEP_SECONDS ago or more: at its closure, or at
//!   its expiry when it has none;
//! - no completion mail of its subscriptions is still pending or being sent;
//! - no delivery flow that has not ended names one of its subscriptions.
//!
//! A pass is one transaction: it looks at the next SCANNED watches after its
//! cursor and moves whole watches until OBSERVED_RUNS runs moved, the most
//! one observation writes. A sweep of every watch starts at most every
//! DONE_SECONDS. A pass interrupted moves nothing; the next sweep finds what
//! is left. Nothing in the archive is ever deleted.
use super::{DONE_SECONDS, MONITOR_SECONDS, store::OBSERVED_RUNS};
use crate::store::Store;
use anyhow::Result;
use rusqlite::{Connection, OptionalExtension, params};

/// How long an ended watch stays in the main tables: as long as one
/// subscription monitors for (ci_subscribe), so a subscription renewed in its
/// own week finds its watch there.
pub(super) const KEEP_SECONDS: i64 = MONITOR_SECONDS;
/// The most watches a pass looks at: as many as Core monitors at once.
const SCANNED: i64 = super::admission::LIVE_TARGETS;
/// The pause between two sweeps of every watch: the pace finished watches
/// are read at.
pub(super) const SWEEP_SECONDS: i64 = DONE_SECONDS;

pub(super) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS ci_watches_archive(id TEXT PRIMARY KEY,next_poll INTEGER NOT NULL,failures INTEGER NOT NULL,data TEXT NOT NULL,archived_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ci_subscriptions_archive(id TEXT PRIMARY KEY,ord INTEGER NOT NULL UNIQUE,watch_id TEXT NOT NULL,agent_id TEXT NOT NULL,task_id TEXT NOT NULL,active INTEGER NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ci_subscriptions_archive_watch ON ci_subscriptions_archive(watch_id);
        CREATE INDEX IF NOT EXISTS ci_subscriptions_archive_task ON ci_subscriptions_archive(task_id,ord);
        CREATE INDEX IF NOT EXISTS ci_subscriptions_archive_agent ON ci_subscriptions_archive(agent_id,ord);
        CREATE TABLE IF NOT EXISTS ci_interests_archive(id TEXT PRIMARY KEY,ord INTEGER NOT NULL,subscription_id TEXT NOT NULL,owner TEXT NOT NULL,active INTEGER NOT NULL,expires INTEGER NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ci_interests_archive_subscription ON ci_interests_archive(subscription_id,ord);
        CREATE TABLE IF NOT EXISTS ci_notifications_archive(subscription_id TEXT NOT NULL,run_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(subscription_id,run_id));
        CREATE TABLE IF NOT EXISTS ci_watch_runs_archive(watch_id TEXT NOT NULL,run_id TEXT NOT NULL,PRIMARY KEY(watch_id,run_id));
        CREATE INDEX IF NOT EXISTS ci_watch_runs_archive_run ON ci_watch_runs_archive(run_id);
        CREATE TABLE IF NOT EXISTS ci_runs_archive(seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,run_id TEXT,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS ci_runs_archive_run ON ci_runs_archive(run_id,seq);
        -- What a move asks of the main tables: another watch's link to a run,
        -- and the foreign keys of a removed run.
        CREATE INDEX IF NOT EXISTS ci_watch_runs_run ON ci_watch_runs(run_id);
        CREATE INDEX IF NOT EXISTS ci_notifications_run ON ci_notifications(run_id);",
    )?;
    Ok(())
}

/// Where a watch and everything of it is: the main tables or their archive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Place {
    Main,
    Archive,
}
impl Place {
    pub(crate) fn watches(self) -> &'static str {
        match self {
            Place::Main => "ci_watches",
            Place::Archive => "ci_watches_archive",
        }
    }
    pub(crate) fn subscriptions(self) -> &'static str {
        match self {
            Place::Main => "ci_subscriptions",
            Place::Archive => "ci_subscriptions_archive",
        }
    }
    pub(crate) fn interests(self) -> &'static str {
        match self {
            Place::Main => "ci_interests",
            Place::Archive => "ci_interests_archive",
        }
    }
    /// The column that orders a table's rows as they were made.
    pub(crate) fn order(self) -> &'static str {
        match self {
            Place::Main => "rowid",
            Place::Archive => "ord",
        }
    }
}

/// The subscription's place, if it exists.
pub(crate) fn subscription_place(db: &Connection, id: &str) -> Result<Option<Place>> {
    for place in [Place::Main, Place::Archive] {
        let found = db
            .query_row(&format!("SELECT 1 FROM {} WHERE id=?1", place.subscriptions()), [id], |_| Ok(()))
            .optional()?;
        if found.is_some() {
            return Ok(Some(place));
        }
    }
    Ok(None)
}

/// A run's record and whether it is archived.
pub(crate) fn run(db: &Connection, id: &str) -> Result<Option<(String, bool)>> {
    let main: Option<String> = db.query_row("SELECT data FROM ci_runs WHERE id=?1", [id], |r| r.get(0)).optional()?;
    if let Some(data) = main {
        return Ok(Some((data, false)));
    }
    let archived: Option<String> =
        db.query_row("SELECT data FROM ci_runs_archive WHERE id=?1", [id], |r| r.get(0)).optional()?;
    Ok(archived.map(|data| (data, true)))
}

/// An archived watch's newest run among its archived runs, and among its runs
/// another, live watch keeps in the main table.
pub(crate) const LATEST_ARCHIVED_RUN: &str = "SELECT r.seq,r.data FROM ci_watch_runs_archive w CROSS JOIN ci_runs_archive r ON r.id=w.run_id WHERE w.watch_id=?1 ORDER BY r.seq DESC LIMIT 1";
pub(crate) const LATEST_KEPT_RUN: &str = "SELECT r.seq,r.data FROM ci_watch_runs_archive w CROSS JOIN ci_runs r ON r.id=w.run_id WHERE w.watch_id=?1 ORDER BY r.seq DESC LIMIT 1";
/// A task's newest archived subscriptions, and how many it has.
pub(crate) const NEWEST_ARCHIVED_SUBSCRIPTIONS: &str = "SELECT id,watch_id,ord FROM ci_subscriptions_archive WHERE task_id=?1 ORDER BY ord DESC LIMIT ?2";
pub(crate) const ARCHIVED_SUBSCRIPTION_COUNT: &str = "SELECT COUNT(*) FROM ci_subscriptions_archive WHERE task_id=?1";

/// The runs of watch `wid` in `place`, newest first.
pub(crate) fn watch_runs(db: &Connection, wid: &str, place: Place) -> Result<Vec<String>> {
    let sql = match place {
        Place::Main => "SELECT r.seq,r.data FROM ci_watch_runs w JOIN ci_runs r ON r.id=w.run_id WHERE w.watch_id=?1",
        Place::Archive => "SELECT r.seq,r.data FROM ci_watch_runs_archive w JOIN ci_runs r ON r.id=w.run_id WHERE w.watch_id=?1
            UNION ALL SELECT r.seq,r.data FROM ci_watch_runs_archive w JOIN ci_runs_archive r ON r.id=w.run_id WHERE w.watch_id=?1",
    };
    let mut q = db.prepare(sql)?;
    let mut rows = q
        .query_map([wid], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(rows.into_iter().map(|r| r.1).collect())
}
/// An archived watch's newest run.
pub(crate) fn latest_archived_run(db: &Connection, wid: &str) -> Result<Option<String>> {
    let mut newest: Option<(i64, String)> = None;
    for sql in [LATEST_ARCHIVED_RUN, LATEST_KEPT_RUN] {
        let row: Option<(i64, String)> = db.query_row(sql, [wid], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some(row) = row.filter(|row| newest.as_ref().is_none_or(|n| row.0 > n.0)) {
            newest = Some(row);
        }
    }
    Ok(newest.map(|n| n.1))
}

/// The rowid of a new subscription: after every subscription made before,
/// archived ones too, so the order subscriptions were made in stays one order.
pub(super) const NEXT_SUBSCRIPTION: &str = "(SELECT MAX(n)+1 FROM (SELECT COALESCE(MAX(rowid),0) AS n FROM ci_subscriptions UNION ALL SELECT COALESCE(MAX(ord),0) FROM ci_subscriptions_archive))";

/// Moves archived run `rid` back to the main table, as an observation of a
/// live watch is about to link it.
pub(super) fn restore_run(db: &Connection, rid: &str) -> Result<()> {
    db.execute("INSERT OR IGNORE INTO ci_runs(seq,id,data) SELECT seq,id,data FROM ci_runs_archive WHERE id=?1", [rid])?;
    db.execute("DELETE FROM ci_runs_archive WHERE id=?1 AND EXISTS(SELECT 1 FROM ci_runs WHERE id=?1)", [rid])?;
    Ok(())
}

/// Moves archived watch `wid` back to the main tables, in the order it was
/// made, as a new subscription to it is about to be made. Answers whether it
/// was archived. A subscription the main tables already hold for the same
/// Agent and task (an older release, run in between, made one) stays archived
/// with what is its own, and stays readable.
pub(super) fn restore_watch(db: &Connection, wid: &str) -> Result<bool> {
    let archived = db
        .query_row("SELECT 1 FROM ci_watches_archive WHERE id=?1", [wid], |_| Ok(()))
        .optional()?;
    if archived.is_none() {
        return Ok(false);
    }
    // The main table's own row, if any, is the newer.
    db.execute(
        "INSERT OR IGNORE INTO ci_watches(id,next_poll,failures,data) SELECT id,next_poll,failures,data FROM ci_watches_archive WHERE id=?1",
        [wid],
    )?;
    let mut q = db.prepare("SELECT run_id FROM ci_watch_runs_archive WHERE watch_id=?1")?;
    let runs = q.query_map([wid], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for rid in &runs {
        restore_run(db, rid)?;
    }
    db.execute(
        "INSERT OR IGNORE INTO ci_watch_runs(watch_id,run_id) SELECT a.watch_id,a.run_id FROM ci_watch_runs_archive a
         WHERE a.watch_id=?1 AND EXISTS(SELECT 1 FROM ci_runs r WHERE r.id=a.run_id)",
        [wid],
    )?;
    let mut q = db.prepare("SELECT id FROM ci_subscriptions_archive WHERE watch_id=?1 ORDER BY ord")?;
    let subs = q.query_map([wid], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for sid in &subs {
        // It keeps its place among all subscriptions; one an older release
        // took meanwhile is given the next.
        let back = db.execute(
            "INSERT OR IGNORE INTO ci_subscriptions(rowid,id,watch_id,agent_id,task_id,active,expires,data)
             SELECT CASE WHEN EXISTS(SELECT 1 FROM ci_subscriptions m WHERE m.rowid=a.ord) THEN NULL ELSE a.ord END,
                    a.id,a.watch_id,a.agent_id,a.task_id,a.active,a.expires,a.data
             FROM ci_subscriptions_archive a WHERE a.id=?1",
            [sid],
        )?;
        if back == 0 {
            continue;
        }
        for sql in [
            "INSERT OR IGNORE INTO ci_interests(id,subscription_id,owner,active,expires,data)
             SELECT id,subscription_id,owner,active,expires,data FROM ci_interests_archive WHERE subscription_id=?1 ORDER BY ord",
            "INSERT OR IGNORE INTO ci_notifications(subscription_id,run_id,message_id)
             SELECT n.subscription_id,n.run_id,n.message_id FROM ci_notifications_archive n
             WHERE n.subscription_id=?1 AND EXISTS(SELECT 1 FROM ci_runs r WHERE r.id=n.run_id)",
            "DELETE FROM ci_interests_archive WHERE subscription_id=?1",
            "DELETE FROM ci_notifications_archive WHERE subscription_id=?1",
            "DELETE FROM ci_subscriptions_archive WHERE id=?1",
        ] {
            db.execute(sql, [sid])?;
        }
    }
    let left = db
        .query_row("SELECT 1 FROM ci_subscriptions_archive WHERE watch_id=?1", [wid], |_| Ok(()))
        .optional()?;
    if left.is_none() {
        db.execute("DELETE FROM ci_watch_runs_archive WHERE watch_id=?1", [wid])?;
        db.execute("DELETE FROM ci_watches_archive WHERE id=?1", [wid])?;
    }
    Ok(true)
}

/// Whether watch `?1` may move at `?2`, as the module says.
const MOVABLE: &str = "SELECT EXISTS(SELECT 1 FROM ci_subscriptions s WHERE s.watch_id=?1)
    AND NOT EXISTS(SELECT 1 FROM ci_subscriptions s WHERE s.watch_id=?1 AND s.active=1)
    AND NOT EXISTS(SELECT 1 FROM ci_subscriptions s JOIN ci_interests i ON i.subscription_id=s.id WHERE s.watch_id=?1 AND i.active=1)
    AND (SELECT MAX(COALESCE(CAST(strftime('%s',json_extract(s.data,'$.closure.at')) AS INTEGER),s.expires))
         FROM ci_subscriptions s WHERE s.watch_id=?1) <= ?2-?3
    AND NOT EXISTS(SELECT 1 FROM ci_subscriptions s JOIN ci_notifications n ON n.subscription_id=s.id
         JOIN collaboration_messages m ON m.id=n.message_id WHERE s.watch_id=?1 AND m.delivery_state IN ('pending','sending'))
    AND NOT EXISTS(SELECT 1 FROM ci_subscriptions s JOIN delivery_flows f ON f.task_id=s.task_id, json_each(f.data,'$.rounds') r
         WHERE s.watch_id=?1 AND json_type(f.data,'$.terminal') IS NOT 'object' AND json_extract(r.value,'$.ci.id')=s.id)";

/// Moves watch `wid` into the archive, as one unit. Answers how many runs
/// went with it.
fn archive_watch(db: &Connection, wid: &str, now: i64) -> Result<usize> {
    // What an older release, run in between, left of the same watch in the
    // archive gives way to the main tables' newer rows.
    db.execute(
        "INSERT OR REPLACE INTO ci_watches_archive(id,next_poll,failures,data,archived_at) SELECT id,next_poll,failures,data,?2 FROM ci_watches WHERE id=?1",
        params![wid, now],
    )?;
    // Each subscription keeps its place among all, unless an archived one
    // already has it (an older release reused it): then it comes after
    // every one there is.
    db.execute(
        "INSERT OR REPLACE INTO ci_subscriptions_archive(id,ord,watch_id,agent_id,task_id,active,expires,data)
         SELECT id,CASE WHEN EXISTS(SELECT 1 FROM ci_subscriptions_archive a WHERE a.ord=s.rowid AND a.id<>s.id)
                        THEN (SELECT MAX(n) FROM (SELECT MAX(ord) AS n FROM ci_subscriptions_archive UNION ALL SELECT MAX(rowid) FROM ci_subscriptions))+s.rowid
                        ELSE s.rowid END,
                watch_id,agent_id,task_id,active,expires,data FROM ci_subscriptions s WHERE watch_id=?1",
        [wid],
    )?;
    for sql in [
        "INSERT OR REPLACE INTO ci_interests_archive(id,ord,subscription_id,owner,active,expires,data)
         SELECT i.id,i.rowid,i.subscription_id,i.owner,i.active,i.expires,i.data FROM ci_interests i
         JOIN ci_subscriptions s ON s.id=i.subscription_id WHERE s.watch_id=?1",
        "INSERT OR REPLACE INTO ci_notifications_archive(subscription_id,run_id,message_id)
         SELECT n.subscription_id,n.run_id,n.message_id FROM ci_notifications n
         JOIN ci_subscriptions s ON s.id=n.subscription_id WHERE s.watch_id=?1",
        "INSERT OR IGNORE INTO ci_watch_runs_archive(watch_id,run_id) SELECT watch_id,run_id FROM ci_watch_runs WHERE watch_id=?1",
        // Children first, as the foreign keys require.
        "DELETE FROM ci_interests WHERE subscription_id IN (SELECT id FROM ci_subscriptions WHERE watch_id=?1)",
        "DELETE FROM ci_notifications WHERE subscription_id IN (SELECT id FROM ci_subscriptions WHERE watch_id=?1)",
        "DELETE FROM ci_subscriptions WHERE watch_id=?1",
        "DELETE FROM ci_watch_runs WHERE watch_id=?1",
    ] {
        db.execute(sql, [wid])?;
    }
    // Its runs no main watch links any more, and no main receipt names.
    let mut q = db.prepare(
        "SELECT a.run_id FROM ci_watch_runs_archive a JOIN ci_runs r ON r.id=a.run_id WHERE a.watch_id=?1
         AND NOT EXISTS(SELECT 1 FROM ci_watch_runs o WHERE o.run_id=a.run_id)
         AND NOT EXISTS(SELECT 1 FROM ci_notifications n WHERE n.run_id=a.run_id)",
    )?;
    let runs = q.query_map([wid], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for rid in &runs {
        db.execute(
            "INSERT OR REPLACE INTO ci_runs_archive(seq,id,run_id,data) SELECT seq,id,json_extract(data,'$.runId'),data FROM ci_runs WHERE id=?1",
            [rid],
        )?;
        db.execute("DELETE FROM ci_runs WHERE id=?1", [rid])?;
    }
    db.execute("DELETE FROM ci_watches WHERE id=?1", [wid])?;
    Ok(runs.len())
}

/// What one pass did, and the cursor of the next one in this sweep (None:
/// the sweep is over).
#[derive(Debug, Default)]
pub(crate) struct Pass {
    pub(crate) watches: usize,
    pub(crate) runs: usize,
    pub(crate) next: Option<i64>,
}

impl Store {
    /// One pass of a sweep, from the watch after rowid `after`, at `now`.
    pub(crate) fn ci_archive_pass(&self, after: i64, now: i64) -> Result<Pass> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut q = tx.prepare("SELECT rowid,id FROM ci_watches WHERE rowid>?1 ORDER BY rowid LIMIT ?2")?;
        let candidates = q
            .query_map(params![after, SCANNED], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(q);
        let mut pass = Pass {
            next: (candidates.len() as i64 == SCANNED).then(|| candidates.last().map(|c| c.0)).flatten(),
            ..Pass::default()
        };
        for (rowid, wid) in &candidates {
            let movable: Option<bool> = tx.query_row(MOVABLE, params![wid, now, KEEP_SECONDS], |r| r.get(0))?;
            if movable != Some(true) {
                continue;
            }
            pass.runs += archive_watch(&tx, wid, now)?;
            pass.watches += 1;
            if pass.runs >= OBSERVED_RUNS {
                // The rest of this page waits for the next pass.
                pass.next = Some(*rowid);
                break;
            }
        }
        tx.commit()?;
        Ok(pass)
    }
}
