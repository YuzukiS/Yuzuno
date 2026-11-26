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
//! A pass is one transaction. It looks at the next SCANNED watches after its
//! cursor and moves at most OBSERVED_RUNS rows of receipts, run links and
//! runs, the most one observation writes: a cap, not a threshold. A watch
//! with more moves over several passes, each resuming at it: its receipts
//! first, which only a restore reads; then its run links, oldest run first,
//! each with its run once no main watch links it; last the watch with its
//! subscriptions and their interests, a few rows that runs do not add to.
//! Until then the watch and its subscriptions read from the main tables and
//! its runs from both. A sweep of every watch starts at most every
//! DONE_SECONDS. A pass interrupted moves nothing; the next one resumes where
//! the last committed one stopped. Nothing in the archive is ever deleted.
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

/// The runs of watch `wid`, newest first. Its links may be in either place
/// while it moves over several passes, and so may each run.
pub(crate) fn watch_runs(db: &Connection, wid: &str) -> Result<Vec<String>> {
    let mut q = db.prepare(
        "SELECT r.seq,r.data FROM ci_watch_runs w JOIN ci_runs r ON r.id=w.run_id WHERE w.watch_id=?1
         UNION ALL SELECT r.seq,r.data FROM ci_watch_runs_archive w JOIN ci_runs r ON r.id=w.run_id WHERE w.watch_id=?1
         UNION ALL SELECT r.seq,r.data FROM ci_watch_runs_archive w JOIN ci_runs_archive r ON r.id=w.run_id WHERE w.watch_id=?1",
    )?;
    let mut rows = q
        .query_map([wid], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.sort_by(|a, b| b.0.cmp(&a.0));
    rows.dedup_by_key(|r| r.0);
    Ok(rows.into_iter().map(|r| r.1).collect())
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

/// Moves what of watch `wid` is archived back to the main tables, in the
/// order it was made, as a new subscription to it is about to be made: all
/// of it, or what a sweep had moved of it so far. Answers whether any of it
/// was archived. A subscription the main tables already hold for the same
/// Agent and task (an older release, run in between, made one) stays archived
/// with what is its own, and stays readable.
pub(super) fn restore_watch(db: &Connection, wid: &str) -> Result<bool> {
    let archived: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM ci_watches_archive WHERE id=?1) OR EXISTS(SELECT 1 FROM ci_watch_runs_archive WHERE watch_id=?1)
         OR EXISTS(SELECT 1 FROM ci_notifications_archive n JOIN ci_subscriptions s ON s.id=n.subscription_id WHERE s.watch_id=?1)",
        [wid],
        |r| r.get(0),
    )?;
    if !archived {
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
    db.execute(
        "DELETE FROM ci_watch_runs_archive WHERE watch_id=?1 AND EXISTS(SELECT 1 FROM ci_watch_runs m WHERE m.watch_id=ci_watch_runs_archive.watch_id AND m.run_id=ci_watch_runs_archive.run_id)",
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
            "DELETE FROM ci_interests_archive WHERE subscription_id=?1",
            "DELETE FROM ci_subscriptions_archive WHERE id=?1",
        ] {
            db.execute(sql, [sid])?;
        }
    }
    // The receipts of every subscription of it now in the main tables, of
    // runs in the main table, so that none of those is mailed again.
    db.execute(
        "INSERT OR IGNORE INTO ci_notifications(subscription_id,run_id,message_id)
         SELECT n.subscription_id,n.run_id,n.message_id FROM ci_notifications_archive n JOIN ci_subscriptions s ON s.id=n.subscription_id
         WHERE s.watch_id=?1 AND EXISTS(SELECT 1 FROM ci_runs r WHERE r.id=n.run_id)",
        [wid],
    )?;
    db.execute(
        "DELETE FROM ci_notifications_archive WHERE subscription_id IN (SELECT id FROM ci_subscriptions WHERE watch_id=?1)
         AND EXISTS(SELECT 1 FROM ci_notifications m WHERE m.subscription_id=ci_notifications_archive.subscription_id AND m.run_id=ci_notifications_archive.run_id)",
        [wid],
    )?;
    let left = db
        .query_row("SELECT 1 FROM ci_subscriptions_archive WHERE watch_id=?1", [wid], |_| Ok(()))
        .optional()?;
    if left.is_none() {
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

/// What one call of `archive_watch` moved.
#[derive(Default)]
struct Moved {
    /// Receipts, run links and runs: what the pass's cap counts.
    rows: usize,
    runs: usize,
    /// The watch itself moved: nothing of it is left in the main tables.
    done: bool,
}

/// Moves watch `wid` into the archive, as far as `budget` rows of receipts,
/// links and runs allow, in the order the module says.
fn archive_watch(db: &Connection, wid: &str, now: i64, budget: usize) -> Result<Moved> {
    let mut moved = Moved::default();
    // Its receipts: only a restore reads an ended subscription's.
    let mut q = db.prepare(
        "SELECT n.subscription_id,n.run_id FROM ci_notifications n JOIN ci_subscriptions s ON s.id=n.subscription_id WHERE s.watch_id=?1 LIMIT ?2",
    )?;
    let receipts = q
        .query_map(params![wid, budget as i64 + 1], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (sid, rid) in receipts.iter().take(budget) {
        db.execute(
            "INSERT OR REPLACE INTO ci_notifications_archive(subscription_id,run_id,message_id)
             SELECT subscription_id,run_id,message_id FROM ci_notifications WHERE subscription_id=?1 AND run_id=?2",
            params![sid, rid],
        )?;
        db.execute("DELETE FROM ci_notifications WHERE subscription_id=?1 AND run_id=?2", params![sid, rid])?;
        moved.rows += 1;
    }
    if receipts.len() > budget {
        return Ok(moved);
    }
    // Its run links, oldest run first, each with its run once no main watch
    // links it and no main receipt names it: at most two rows each.
    let links_left = (budget - moved.rows) / 2;
    let mut q = db.prepare(
        "SELECT w.run_id FROM ci_watch_runs w JOIN ci_runs r ON r.id=w.run_id WHERE w.watch_id=?1 ORDER BY r.seq LIMIT ?2",
    )?;
    let links = q
        .query_map(params![wid, links_left as i64 + 1], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for rid in links.iter().take(links_left) {
        db.execute("INSERT OR IGNORE INTO ci_watch_runs_archive(watch_id,run_id) VALUES(?1,?2)", params![wid, rid])?;
        db.execute("DELETE FROM ci_watch_runs WHERE watch_id=?1 AND run_id=?2", params![wid, rid])?;
        moved.rows += 1;
        let free: bool = db.query_row(
            "SELECT NOT EXISTS(SELECT 1 FROM ci_watch_runs WHERE run_id=?1) AND NOT EXISTS(SELECT 1 FROM ci_notifications WHERE run_id=?1)",
            [rid],
            |r| r.get(0),
        )?;
        if free {
            db.execute(
                "INSERT OR REPLACE INTO ci_runs_archive(seq,id,run_id,data) SELECT seq,id,json_extract(data,'$.runId'),data FROM ci_runs WHERE id=?1",
                [rid],
            )?;
            db.execute("DELETE FROM ci_runs WHERE id=?1", [rid])?;
            moved.rows += 1;
            moved.runs += 1;
        }
    }
    if links.len() > links_left {
        return Ok(moved);
    }
    // Last the watch, its subscriptions and their interests. What an older
    // release, run in between, left of the same watch in the archive gives
    // way to the main tables' newer rows.
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
        // Children first, as the foreign keys require.
        "DELETE FROM ci_interests WHERE subscription_id IN (SELECT id FROM ci_subscriptions WHERE watch_id=?1)",
        "DELETE FROM ci_subscriptions WHERE watch_id=?1",
        "DELETE FROM ci_watches WHERE id=?1",
    ] {
        db.execute(sql, [wid])?;
    }
    moved.done = true;
    Ok(moved)
}

/// What one pass did, and the cursor of the next one in this sweep (None:
/// the sweep is over).
#[derive(Debug, Default)]
pub(crate) struct Pass {
    /// Watches moved whole in this pass.
    pub(crate) watches: usize,
    /// Receipts, run links and runs moved: at most OBSERVED_RUNS.
    pub(crate) rows: usize,
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
            let moved = archive_watch(&tx, wid, now, OBSERVED_RUNS - pass.rows)?;
            pass.rows += moved.rows;
            pass.runs += moved.runs;
            if moved.done {
                pass.watches += 1;
            }
            if !moved.done || pass.rows >= OBSERVED_RUNS {
                // The next pass resumes at this watch, or after it.
                pass.next = Some(if moved.done { *rowid } else { *rowid - 1 });
                break;
            }
        }
        tx.commit()?;
        Ok(pass)
    }
}
