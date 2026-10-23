//! How Store reaches SQLite: exactly one writer and a pool of read-only WAL
//! connections, used from blocking threads only.
//!
//! - **One writer.** Every statement that changes the file runs on the writer
//!   (`Db::write`). It is behind a fair lock, so writers are served in arrival
//!   order and none can be starved by a busier one. Its transactions begin
//!   IMMEDIATE: a write transaction holds SQLite's write lock from its first
//!   statement, so it never has to upgrade a read snapshot half-way (and fail
//!   with "database is busy" when another process wrote). Every existing
//!   multi-statement operation keeps its own transaction, so it stays atomic
//!   exactly as before.
//! - **Reads never wait for the writer.** `Db::read` hands out a read-only
//!   connection inside a read transaction: in WAL mode it sees one committed
//!   snapshot for as long as it is held, but it neither waits for nor blocks
//!   the writer. Idle readers are pooled; when all are busy a new one is
//!   opened instead of waiting, so a read can never deadlock against the
//!   writer or another read.
//! - **Without WAL** (a file system that cannot share memory, for example) a
//!   reader would block the writer's commit for as long as it holds its
//!   snapshot. Core then logs a warning and reads share the writer, as every
//!   access did before this module: slower, never failing.
//! - **Off the async workers.** Both calls block. Async code reaches the store
//!   through `blocking` (or `Workspace::stored`), which runs the whole job —
//!   SQLite and the record (de)serialization around it — on Tokio's blocking
//!   pool. Jobs are short (milliseconds to a few hundred for a multi-megabyte
//!   record in a debug build), which is what that pool is for; a dedicated
//!   writer thread would also need 'static jobs, i.e. rewriting every Store
//!   method that mutates its in-memory copies inside the same critical section.
//!   No job ever waits for another job (the writer and Store's locks are held
//!   only by running jobs, readers never wait), so a bounded pool cannot
//!   deadlock: a queued job only waits for a running one to finish.
//! - **Durability.** The writer is two connections behind its one lock: the
//!   main one with `synchronous=FULL`, and `Write::unsynced` with NORMAL, for
//!   commits that need not sync the WAL (journal rows a record can be rebuilt
//!   from, and records the journal can rebuild). Only one is used at a time,
//!   so there is still exactly one writer, and neither ever changes mode, so
//!   no ordinary commit can be left unsynced. Without WAL, NORMAL can corrupt
//!   the database on a power loss, so the second connection is FULL too. A
//!   transaction a panic left open on either is rolled back the next time the
//!   writer is taken.
//!
//! Lock order (outermost first): a Workspace per-Agent lock, then Store's
//! per-Agent record lock, then at most one connection from here (writer *or*
//! reader); Store's in-memory state and a held record's own lock are taken
//! last and never held while waiting for anything else (see `store`). A
//! thread never asks for the writer (or, without WAL, a reader) while it
//! already holds it; that would deadlock, so it is refused instead.
use anyhow::{bail, Context, Result};
use parking_lot::{FairMutex, FairMutexGuard};
use rusqlite::{Connection, OpenFlags, TransactionBehavior};
use std::{
    cell::Cell,
    ops::{Deref, DerefMut},
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};

/// Idle read connections kept open; more are opened while needed.
const IDLE_READERS: usize = 8;

thread_local! {
    /// This thread holds the writer (see the lock order above).
    static WRITING: Cell<bool> = const { Cell::new(false) };
    /// This thread runs a `blocking` job.
    static IN_JOB: Cell<bool> = const { Cell::new(false) };
}

pub struct Db {
    path: PathBuf,
    /// Without WAL, reads share the writer (see above).
    wal: bool,
    writer: FairMutex<Writer>,
    readers: Mutex<Vec<Connection>>,
}

struct Writer {
    synced: Connection,
    unsynced: Connection,
}

impl Db {
    /// Takes the configured write connection (schema and pragmas already
    /// applied by Store, `synchronous=FULL`) and makes it the only writer,
    /// with a second connection to the same file for unsynced commits.
    pub fn new(path: &Path, mut synced: Connection) -> Result<Self> {
        let mode: String = synced.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
        let wal = mode.eq_ignore_ascii_case("wal");
        if !wal {
            eprintln!("Workspace database is not in WAL mode (journal_mode={mode}); reads will wait for writes");
        }
        synced.set_transaction_behavior(TransactionBehavior::Immediate);
        let mut unsynced = Connection::open(path)?;
        unsynced.busy_timeout(Duration::from_secs(3))?;
        // NORMAL is safe only with WAL: a rollback journal needs FULL to
        // survive a power loss.
        unsynced.execute_batch(if wal {
            "PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL;"
        } else {
            "PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;"
        })?;
        unsynced.set_transaction_behavior(TransactionBehavior::Immediate);
        Ok(Self {
            path: path.to_owned(),
            wal,
            writer: FairMutex::new(Writer {
                synced,
                unsynced,
            }),
            readers: Mutex::default(),
        })
    }

    /// The writer, outside any transaction.
    pub fn write(&self) -> Result<Write<'_>> {
        let writer = self.lock_writer()?;
        for connection in [&writer.synced, &writer.unsynced] {
            // A cheap flag, not a query. Only a panic inside a write can
            // leave a transaction open; it is never committed.
            if !connection.is_autocommit() {
                connection.execute_batch("ROLLBACK").context("Workspace 写入连接无法回滚未完成的事务")?;
            }
        }
        Ok(Write(Held::new(writer)))
    }

    /// A read-only connection holding one snapshot until dropped.
    pub fn read(&self) -> Result<Read<'_>> {
        if !self.wal {
            return Ok(Read { db: self, connection: Reader::Shared(Held::new(self.lock_writer()?)) });
        }
        let idle = self.readers.lock().unwrap().pop();
        let connection = match idle {
            Some(connection) => connection,
            None => {
                let connection = Connection::open_with_flags(&self.path,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX | OpenFlags::SQLITE_OPEN_URI)
                    .context("无法打开 Workspace 只读连接")?;
                connection.busy_timeout(Duration::from_secs(3))?;
                connection
            }
        };
        // DEFERRED: the snapshot starts with the first read and lasts until drop.
        connection.execute_batch("BEGIN")?;
        Ok(Read { db: self, connection: Reader::Pooled(Some(connection)) })
    }

    fn lock_writer(&self) -> Result<FairMutexGuard<'_, Writer>> {
        if WRITING.get() {
            bail!("Workspace 数据库连接被同一线程重复请求（内部错误）；已拒绝，避免死锁");
        }
        Ok(self.writer.lock())
    }

    /// The main writer connection's setting.
    #[cfg(test)]
    pub(crate) fn writer_synchronous(&self) -> i64 {
        synchronous(&self.writer.lock().synced).unwrap()
    }

    /// The unsynced connection's setting.
    #[cfg(test)]
    pub(crate) fn unsynced_synchronous(&self) -> i64 {
        synchronous(&self.writer.lock().unsynced).unwrap()
    }

    /// Whether reads use their own snapshot connections (WAL) rather than
    /// the writer.
    pub(crate) fn is_wal(&self) -> bool {
        self.wal
    }
}

#[cfg(test)]
fn synchronous(connection: &Connection) -> Result<i64> {
    Ok(connection.query_row("PRAGMA synchronous", [], |r| r.get(0))?)
}

/// The writer, marked as held by this thread while it lives.
struct Held<'a>(FairMutexGuard<'a, Writer>);

impl<'a> Held<'a> {
    fn new(guard: FairMutexGuard<'a, Writer>) -> Self {
        WRITING.set(true);
        Self(guard)
    }
}

impl Drop for Held<'_> {
    fn drop(&mut self) {
        WRITING.set(false);
    }
}

pub struct Write<'a>(Held<'a>);

impl Write<'_> {
    /// The writer's connection that commits without syncing the WAL
    /// (`synchronous=NORMAL`, about 2 ms less per commit here). Committed
    /// changes survive a Core crash; the next synced commit makes them
    /// durable through a power loss too.
    pub fn unsynced(&mut self) -> &mut Connection { &mut self.0 .0.unsynced }
}

impl Deref for Write<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection { &self.0 .0.synced }
}

impl DerefMut for Write<'_> {
    fn deref_mut(&mut self) -> &mut Connection { &mut self.0 .0.synced }
}

pub struct Read<'a> {
    db: &'a Db,
    connection: Reader<'a>,
}

enum Reader<'a> {
    Pooled(Option<Connection>),
    Shared(Held<'a>),
}

impl Deref for Read<'_> {
    type Target = Connection;
    fn deref(&self) -> &Connection {
        match &self.connection {
            Reader::Pooled(connection) => connection.as_ref().unwrap(),
            Reader::Shared(writer) => &writer.0.synced,
        }
    }
}

impl Drop for Read<'_> {
    fn drop(&mut self) {
        let Reader::Pooled(connection) = &mut self.connection else { return };
        let Some(connection) = connection.take() else { return };
        // A connection whose snapshot cannot be ended is closed, not reused.
        if connection.execute_batch("ROLLBACK").is_ok() || connection.is_autocommit() {
            let mut idle = self.db.readers.lock().unwrap();
            if idle.len() < IDLE_READERS { idle.push(connection); }
        }
    }
}

/// Runs store work on Tokio's blocking pool and waits for it. The job runs to
/// completion even if the caller stops waiting. A panic in it is resumed in
/// the caller, as if it had run inline.
pub async fn blocking<T: Send + 'static>(job: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    struct InJob;
    impl Drop for InJob {
        fn drop(&mut self) {
            IN_JOB.set(false);
        }
    }
    let job = move || {
        IN_JOB.set(true);
        let _in_job = InJob;
        job()
    };
    match tokio::task::spawn_blocking(job).await {
        Ok(result) => result,
        Err(error) if error.is_panic() => std::panic::resume_unwind(error.into_panic()),
        Err(error) => Err(error.into()),
    }
}

/// Whether this thread may wait for Store's locks and build what it reads:
/// true in a `blocking` job and on any thread outside the async runtime,
/// false on an async worker.
pub fn off_worker() -> bool {
    IN_JOB.get() || tokio::runtime::Handle::try_current().is_err()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn open_in(dir: &Path, journal: &str) -> Db {
        let path = dir.join("db.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch(&format!("PRAGMA journal_mode={journal}; PRAGMA synchronous=FULL; CREATE TABLE t(x INTEGER);")).unwrap();
        Db::new(&path, writer).unwrap()
    }

    fn open(dir: &Path) -> Db {
        open_in(dir, "WAL")
    }

    fn count(db: &Connection) -> i64 {
        db.query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn readers_cannot_write_and_see_one_snapshot() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(dir.path());
        let read = db.read().unwrap();
        assert!(read.execute("INSERT INTO t VALUES(1)", []).is_err());
        let before = count(&read);
        db.write().unwrap().execute("INSERT INTO t VALUES(1)", []).unwrap();
        // Still the snapshot it started with; a new read sees the commit.
        assert_eq!(count(&read), before);
        drop(read);
        assert_eq!(count(&db.read().unwrap()), 1);
    }

    #[test]
    fn write_transactions_take_the_write_lock_at_begin_on_both_connections() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(dir.path());
        let other = Connection::open(dir.path().join("db.sqlite")).unwrap();
        other.busy_timeout(Duration::ZERO).unwrap();
        let mut write = db.write().unwrap();
        // Nothing written yet, but IMMEDIATE already holds the write lock.
        let tx = write.transaction().unwrap();
        assert!(other.execute_batch("BEGIN IMMEDIATE").is_err());
        drop(tx);
        let tx = write.unsynced().transaction().unwrap();
        assert!(other.execute_batch("BEGIN IMMEDIATE").is_err());
        drop(tx);
        other.execute_batch("BEGIN IMMEDIATE; ROLLBACK;").unwrap();
    }

    #[test]
    fn only_the_unsynced_connection_skips_the_sync_and_neither_changes_mode() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(dir.path());
        {
            let mut write = db.write().unwrap();
            write.unsynced().execute("INSERT INTO t VALUES(1)", []).unwrap();
            write.execute("INSERT INTO t VALUES(2)", []).unwrap();
            assert!(write.unsynced().execute_batch("INSERT INTO nowhere VALUES(1)").is_err());
        }
        assert_eq!((db.writer_synchronous(), db.unsynced_synchronous()), (2, 1));
        assert_eq!(count(&db.read().unwrap()), 2);
    }

    #[test]
    fn the_writer_is_always_handed_out_outside_a_transaction() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(dir.path());
        // A panic inside an open transaction on either connection.
        for unsynced in [false, true] {
            let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                let mut write = db.write().unwrap();
                let connection = if unsynced { write.unsynced() } else { &mut *write };
                connection.execute_batch("BEGIN; INSERT INTO t VALUES(7);").unwrap();
                panic!("interrupted write");
            }));
            assert!(panicked.is_err());
            let mut write = db.write().unwrap();
            assert!(write.is_autocommit() && write.unsynced().is_autocommit());
            assert_eq!(count(&write), 0);
        }
    }

    #[test]
    fn many_concurrent_readers_never_wait_for_each_other_or_the_writer() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(dir.path());
        let _write = db.write().unwrap();
        // More than the idle pool, all at once, while the writer is held (by
        // another thread, as it would be).
        std::thread::scope(|scope| {
            scope.spawn(|| {
                let held: Vec<_> = (0..IDLE_READERS * 2).map(|_| db.read().unwrap()).collect();
                for read in &held {
                    assert_eq!(count(read), 0);
                }
            }).join().unwrap();
        });
        assert_eq!(db.readers.lock().unwrap().len(), IDLE_READERS);
    }

    #[test]
    fn without_wal_reads_share_the_writer_and_still_work() {
        let dir = tempfile::tempdir().unwrap();
        let db = open_in(dir.path(), "DELETE");
        assert!(!db.wal);
        // NORMAL only with WAL.
        assert_eq!((db.writer_synchronous(), db.unsynced_synchronous()), (2, 2));
        db.write().unwrap().execute("INSERT INTO t VALUES(1)", []).unwrap();
        assert_eq!(count(&db.read().unwrap()), 1);
        // A write requested while this thread reads would wait for itself.
        let read = db.read().unwrap();
        assert!(db.write().is_err());
        drop(read);
        db.write().unwrap().unsynced().execute("INSERT INTO t VALUES(2)", []).unwrap();
        assert_eq!(count(&db.read().unwrap()), 2);
    }

    #[tokio::test]
    async fn store_jobs_and_plain_threads_are_off_the_workers_async_code_is_not() {
        assert!(!off_worker());
        assert!(blocking(|| Ok(off_worker())).await.unwrap());
        assert!(!off_worker(), "the mark ends with the job");
        assert!(std::thread::spawn(off_worker).join().unwrap());
    }

    #[test]
    fn asking_for_the_writer_twice_on_one_thread_is_refused_not_deadlocked() {
        let dir = tempfile::tempdir().unwrap();
        let db = open(dir.path());
        let write = db.write().unwrap();
        assert!(db.write().is_err());
        // Readers are separate connections in WAL mode.
        assert_eq!(count(&db.read().unwrap()), 0);
        drop(write);
        db.write().unwrap();
    }
}
