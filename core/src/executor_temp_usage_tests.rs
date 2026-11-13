//! YN-78 S2c: the temporary-directory walk, its tickets and write-back, and
//! the bounds on its worker. Every unknown is asserted as unknown, never 0.
use super::*;
use crate::model::AgentDetail;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

/// A directory as S2a makes one: 0700, the owner's, under a short root.
fn root() -> (tempfile::TempDir, Given) {
    let dir = tempfile::Builder::new().prefix("yn78-s2c-").tempdir().unwrap();
    let path = std::fs::canonicalize(dir.path()).unwrap().join("t");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    let given = given(&path);
    (dir, given)
}

fn given(path: &Path) -> Given {
    let meta = std::fs::symlink_metadata(path).unwrap();
    Given { path: path.to_path_buf(), dev: meta.dev() as i64, ino: meta.ino() as i64 }
}

/// Nothing mounted anywhere: the mount table a test gives.
fn unmounted() -> Option<Vec<PathBuf>> {
    Some(Vec::new())
}

fn walked_with(given: &Given, limits: &Limits) -> Sample {
    walk(given, limits, std::time::Instant::now() + Duration::from_secs(2), &Wall, &unmounted)
}

fn walked(given: &Given) -> Sample {
    walked_with(given, &LIMITS)
}

/// What a file's own allocated blocks come to, as the walk counts them.
fn allocated(path: &Path) -> i64 {
    std::fs::symlink_metadata(path).unwrap().blocks() as i64 * 512
}

#[test]
fn an_empty_directory_and_empty_folders_measure_zero() {
    let (_dir, t) = root();
    assert_eq!(walked(&t), Sample::Measured(0), "an empty directory is a measured 0");
    std::fs::create_dir_all(t.path.join("a/b/c")).unwrap();
    assert_eq!(walked(&t), Sample::Measured(0), "folders' own metadata is not counted");
}

#[test]
fn files_count_their_allocated_blocks_a_hard_link_once_and_a_link_itself() {
    let (dir, t) = root();
    std::fs::write(t.path.join("small"), b"synthetic scratch\n").unwrap();
    std::fs::create_dir(t.path.join("sub")).unwrap();
    std::fs::write(t.path.join("sub/bigger"), vec![7u8; 64 * 1024]).unwrap();
    let files = allocated(&t.path.join("small")) + allocated(&t.path.join("sub/bigger"));
    assert_eq!(walked(&t), Sample::Measured(files));
    // A second name for the same inode adds nothing.
    std::fs::hard_link(t.path.join("sub/bigger"), t.path.join("again")).unwrap();
    assert_eq!(walked(&t), Sample::Measured(files), "a hard-linked inode counts once");
    // A link to a large file outside counts only the link itself.
    let outside = dir.path().join("outside");
    std::fs::write(&outside, vec![1u8; 1024 * 1024]).unwrap();
    std::os::unix::fs::symlink(&outside, t.path.join("link")).unwrap();
    let link = allocated(&t.path.join("link"));
    assert_eq!(walked(&t), Sample::Measured(files + link), "never what a link names");
    assert!(files + link < allocated(&outside), "the outside file is not in the count");
}

#[test]
fn a_sparse_file_counts_what_is_allocated_not_its_length() {
    let (_dir, t) = root();
    let sparse = t.path.join("sparse");
    std::fs::File::create(&sparse).unwrap().set_len(256 * 1024 * 1024).unwrap();
    let Sample::Measured(bytes) = walked(&t) else { panic!("a sparse file is measured") };
    assert_eq!(bytes, allocated(&sparse));
    assert!(bytes < 256 * 1024 * 1024, "its length is not what it holds: {bytes}");
}

#[test]
fn the_soft_line_and_overflow_by_injected_counts() {
    // Counted as blocks, never written: 2 GiB less 512, 2 GiB, 2 GiB and 512.
    let blocks = SOFT_LIMIT_BYTES / 512;
    for (count, over_it) in [(blocks - 1, false), (blocks, true), (blocks + 1, true)] {
        let mut tally = Tally::default();
        tally.add(1, 1, 1, count, &LIMITS).unwrap();
        let total = tally.total().unwrap();
        assert_eq!(total, count * 512);
        assert_eq!(over(total), over_it, "{total}");
    }
    // Blocks × 512 past 64 bits.
    assert_eq!(Tally::default().add(1, 1, 1, i64::MAX, &LIMITS), Err(Unknown::Overflow));
    // A sum past 64 bits.
    let half = (u64::MAX / 512 / 2 + 1) as i64;
    let mut tally = Tally::default();
    tally.add(1, 1, 1, half, &LIMITS).unwrap();
    assert_eq!(tally.add(1, 2, 1, half, &LIMITS), Err(Unknown::Overflow));
    // A count past what Core keeps (signed 64 bits).
    let mut tally = Tally::default();
    tally.add(1, 1, 1, i64::MAX / 512 + 1, &LIMITS).unwrap();
    assert_eq!(tally.total(), Err(Unknown::Overflow));
    // A negative count from the kernel is an error, not a smaller number.
    assert_eq!(Tally::default().add(1, 1, 1, -1, &LIMITS), Err(Unknown::Error));
    // The same inode with other links, twice: once.
    let mut tally = Tally::default();
    tally.add(1, 9, 2, 8, &LIMITS).unwrap();
    tally.add(1, 9, 2, 8, &LIMITS).unwrap();
    assert_eq!(tally.total(), Ok(8 * 512));
}

#[test]
fn a_replaced_or_linked_directory_is_unknown_and_never_read() {
    let (dir, t) = root();
    std::fs::write(t.path.join("x"), b"x").unwrap();
    // Another directory under the same name.
    let aside = dir.path().join("aside");
    std::fs::rename(&t.path, &aside).unwrap();
    std::fs::create_dir(&t.path).unwrap();
    std::fs::set_permissions(&t.path, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(walked(&t), Sample::Unknown(Unknown::Changed), "not the directory given");
    // A link in its place, to the very directory given.
    std::fs::remove_dir(&t.path).unwrap();
    std::os::unix::fs::symlink(&aside, &t.path).unwrap();
    assert_eq!(walked(&t), Sample::Unknown(Unknown::Changed), "never through a link");
    // Gone.
    std::fs::remove_file(&t.path).unwrap();
    assert_eq!(walked(&t), Sample::Unknown(Unknown::Changed));
    // Its own directory, no longer 0700.
    let mut moved = t.clone();
    moved.path = aside.clone();
    std::fs::set_permissions(&aside, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(walked(&moved), Sample::Unknown(Unknown::Changed), "not 0700");
}

#[test]
fn a_directory_not_under_this_cores_root_is_unavailable_and_never_read() {
    // S2a's own checks, before the walk: under this Core's current <D>/t,
    // with this Agent's name, the same directory. A short root, as S2a's
    // tests use: the path must fit the platform's limit (63 bytes on macOS).
    let dir = tempfile::Builder::new().prefix("yn78-").tempdir_in("/tmp").unwrap();
    let data = std::fs::canonicalize(dir.path()).unwrap().join("d");
    let t = data.join("t").join("abcdefgh");
    std::fs::create_dir_all(&t).unwrap();
    for made in [&data.join("t"), &t] {
        std::fs::set_permissions(made, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    std::fs::write(t.join("x"), b"x").unwrap();
    let given = given(&t);
    let until = std::time::Instant::now() + Duration::from_secs(2);
    let at = |data: &Path, agent: &str| match measure_now(data, agent, &given, until) {
        Sample::Unknown(why) => Some(why),
        Sample::Measured(_) => None,
    };
    // A real mount table: a host whose table can't be read says Mount.
    let here = at(&data, "abcdefgh-1111");
    assert!(matches!(here, None | Some(Unknown::Mount)), "its own directory: {here:?}");
    // An old data directory, as a restored backup leaves.
    let other = data.with_file_name("restored");
    std::fs::create_dir_all(&other).unwrap();
    assert_eq!(at(&other, "abcdefgh-1111"), Some(Unknown::Unavailable));
    // Another Agent's name.
    assert_eq!(at(&data, "zzzzzzzz-1111"), Some(Unknown::Unavailable));
}

#[test]
fn a_mount_below_or_no_mount_table_is_unknown() {
    let (_dir, t) = root();
    std::fs::create_dir(t.path.join("sub")).unwrap();
    let until = || std::time::Instant::now() + Duration::from_secs(2);
    let below = t.path.join("sub");
    let at = |mounts: &dyn Fn() -> Option<Vec<PathBuf>>| walk(&t, &LIMITS, until(), &Wall, mounts);
    assert_eq!(at(&|| Some(vec![below.clone()])), Sample::Unknown(Unknown::Mount), "a mount below, the same device's too");
    assert_eq!(at(&|| Some(vec![t.path.clone()])), Sample::Unknown(Unknown::Mount), "a mount at the directory itself");
    assert_eq!(at(&|| None), Sample::Unknown(Unknown::Mount), "a mount table that can't be read proves nothing");
    // One above it is the file system it is on.
    let above = t.path.parent().unwrap().to_path_buf();
    assert_eq!(at(&|| Some(vec![PathBuf::from("/"), above.clone()])), Sample::Measured(0));
    // A mount that appears while it is walked: the table is read again after.
    let reads = AtomicUsize::new(0);
    let late = || if reads.fetch_add(1, Ordering::SeqCst) == 0 { Some(Vec::new()) } else { Some(vec![below.clone()]) };
    assert_eq!(at(&late), Sample::Unknown(Unknown::Mount));
    // This host's real table, on Linux: nothing is mounted below a test's temporary directory.
    #[cfg(target_os = "linux")]
    assert_eq!(walk(&t, &LIMITS, until(), &Wall, &crate::build_output::mounts), Sample::Measured(0));
}

#[test]
fn a_folder_or_entry_that_cannot_be_read_is_unknown() {
    if rustix::process::getuid().is_root() {
        eprintln!("skipped: permissions are not enforced for root");
        return;
    }
    let (_dir, t) = root();
    let closed = t.path.join("closed");
    std::fs::create_dir(&closed).unwrap();
    std::fs::write(closed.join("x"), b"x").unwrap();
    // Not even opened.
    std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o000)).unwrap();
    let opened = walked(&t);
    // Its names listed, none of them stat-able.
    std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o400)).unwrap();
    let listed = walked(&t);
    std::fs::set_permissions(&closed, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(opened, Sample::Unknown(Unknown::Error), "a folder that can't be opened");
    assert_eq!(listed, Sample::Unknown(Unknown::Error), "an entry that can't be read");
    assert_eq!(walked(&t), Sample::Measured(allocated(&closed.join("x"))), "readable again, measured again");
}

#[test]
fn each_bound_reached_is_unknown_never_zero() {
    let (_dir, t) = root();
    // Entries: four files, a bound of three.
    for name in ["a", "b", "c", "d"] {
        std::fs::File::create(t.path.join(name)).unwrap();
    }
    let tight = |change: fn(&mut Limits)| {
        let mut limits = LIMITS;
        change(&mut limits);
        walked_with(&t, &limits)
    };
    assert_eq!(tight(|l| l.entries = 3), Sample::Unknown(Unknown::Entries));
    assert_eq!(tight(|l| l.entries = 4), Sample::Measured(0), "exactly the bound is complete");
    // A path: "deep/deeper/x" is 13 bytes.
    std::fs::create_dir_all(t.path.join("deep/deeper")).unwrap();
    std::fs::File::create(t.path.join("deep/deeper/x")).unwrap();
    assert_eq!(tight(|l| l.path_bytes = 12), Sample::Unknown(Unknown::Path));
    assert_eq!(tight(|l| l.path_bytes = 13), Sample::Measured(0));
    // Depth: deeper is the second level.
    assert_eq!(tight(|l| l.depth = 1), Sample::Unknown(Unknown::Depth));
    assert_eq!(tight(|l| l.depth = 2), Sample::Measured(0));
    // Open folders: the root, deep and deeper are three.
    assert_eq!(tight(|l| l.open_dirs = 2), Sample::Unknown(Unknown::Handles));
    assert_eq!(tight(|l| l.open_dirs = 3), Sample::Measured(0));
    // Time: already over, and over while it walks.
    assert_eq!(walk(&t, &LIMITS, std::time::Instant::now(), &Wall, &unmounted), Sample::Unknown(Unknown::Timeout));
    struct Steps(AtomicUsize, std::time::Instant);
    impl Clock for Steps {
        fn now(&self) -> std::time::Instant {
            // Each read of the clock is one second later.
            self.1 + Duration::from_secs(self.0.fetch_add(1, Ordering::SeqCst) as u64)
        }
    }
    let start = std::time::Instant::now();
    let steps = Steps(AtomicUsize::new(0), start);
    assert_eq!(walk(&t, &LIMITS, start + Duration::from_secs(3), &steps, &unmounted), Sample::Unknown(Unknown::Timeout));
    assert!(steps.0.load(Ordering::SeqCst) > 1, "it began, then ran out");
    // The bounds Core uses, and their order.
    assert_eq!((LIMITS.entries, LIMITS.path_bytes, LIMITS.depth, LIMITS.open_dirs), (20_000, 4096, 32, 64));
    assert_eq!(BUDGET.time, Duration::from_secs(2));
}

/// Waits, on the real clock, for the worker to say it is at its barrier.
async fn reached(rx: tokio::sync::oneshot::Receiver<()>) {
    tokio::time::timeout(Duration::from_secs(10), rx).await.expect("the worker reached its barrier").unwrap();
}

#[tokio::test]
async fn a_blocked_worker_keeps_its_slot_and_permit_past_the_deadline_and_a_new_turn_starts_nothing() {
    let (slot, global) = (Arc::new(Semaphore::new(BACKGROUND)), Arc::new(Semaphore::new(crate::opencode_responder::FS_GLOBAL)));
    let runs = Arc::new(AtomicUsize::new(0));
    let (at_barrier, worker_there) = tokio::sync::oneshot::channel();
    let (release, barrier) = std::sync::mpsc::channel::<()>();
    let until = Instant::now() + BUDGET.time;
    let first = {
        let (slot, global, runs) = (slot.clone(), global.clone(), runs.clone());
        tokio::spawn(async move {
            attempt(&slot, global, until, move || {
                runs.fetch_add(1, Ordering::SeqCst);
                at_barrier.send(()).unwrap();
                barrier.recv().unwrap();
                Sample::Measured(1)
            }).await
        })
    };
    reached(worker_there).await;
    // Then the deadline, on a paused clock: no fixed sleep.
    tokio::time::pause();
    tokio::time::advance(BUDGET.time + Duration::from_secs(1)).await;
    assert_eq!(first.await.unwrap(), Attempt::Late, "the deadline stops the wait, not the worker");
    assert_eq!((slot.available_permits(), global.available_permits()), (0, crate::opencode_responder::FS_GLOBAL - 1),
        "both permits stay with the worker");
    // The next Turn: busy at once, no second worker.
    let next = {
        let runs = runs.clone();
        attempt(&slot, global.clone(), Instant::now() + BUDGET.time, move || {
            runs.fetch_add(1, Ordering::SeqCst);
            Sample::Measured(2)
        }).await
    };
    assert_eq!(next, Attempt::Busy);
    assert_eq!(runs.load(Ordering::SeqCst), 1, "nothing more ran");
    // Only once the worker really ends are they given back.
    release.send(()).unwrap();
    let _slot = slot.clone().acquire_owned().await.unwrap();
    let _all = global.acquire_many(crate::opencode_responder::FS_GLOBAL as u32).await.unwrap();
}

#[tokio::test]
async fn a_cancelled_measurement_leaves_both_permits_with_its_worker() {
    let (slot, global) = (Arc::new(Semaphore::new(BACKGROUND)), Arc::new(Semaphore::new(crate::opencode_responder::FS_GLOBAL)));
    let (at_barrier, worker_there) = tokio::sync::oneshot::channel();
    let (release, barrier) = std::sync::mpsc::channel::<()>();
    let first = {
        let (slot, global) = (slot.clone(), global.clone());
        tokio::spawn(async move {
            attempt(&slot, global, Instant::now() + BUDGET.time, move || {
                at_barrier.send(()).unwrap();
                barrier.recv().unwrap();
            }).await
        })
    };
    reached(worker_there).await;
    first.abort();
    assert!(first.await.unwrap_err().is_cancelled());
    assert_eq!((slot.available_permits(), global.available_permits()), (0, crate::opencode_responder::FS_GLOBAL - 1));
    release.send(()).unwrap();
    let _slot = slot.clone().acquire_owned().await.unwrap();
    let _all = global.acquire_many(crate::opencode_responder::FS_GLOBAL as u32).await.unwrap();
}

#[tokio::test]
async fn waiting_for_a_permit_shares_the_deadline_and_starts_nothing_late() {
    let (slot, global) = (Arc::new(Semaphore::new(BACKGROUND)), Arc::new(Semaphore::new(1)));
    let _taken = global.clone().acquire_owned().await.unwrap();
    tokio::time::pause();
    let ran = Arc::new(AtomicUsize::new(0));
    let late = {
        let ran = ran.clone();
        attempt(&slot, global.clone(), Instant::now() + BUDGET.time, move || ran.fetch_add(1, Ordering::SeqCst)).await
    };
    assert_eq!(late, Attempt::Late);
    assert_eq!(ran.load(Ordering::SeqCst), 0, "nothing starts after its deadline");
    assert_eq!(slot.available_permits(), BACKGROUND, "the slot goes back with the work that never started");
}

// Tickets and write-back, on a Store.

fn lab() -> (tempfile::TempDir, Store, Given) {
    let dir = tempfile::Builder::new().prefix("yn78-").tempdir_in("/tmp").unwrap();
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"oc","name":"Agent oc",
        "cwd":"/synthetic/work","model":"","harness":"opencode","color":"sage","status":"idle",
        "createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
        "turns":[],"pending":[],"artifacts":[]})).unwrap();
    store.insert(&detail).unwrap();
    store.db.write().unwrap().execute(
        "INSERT INTO agent_roles(agent_id,kind,template_id,created_by,state,created_at,updated_at)
         VALUES('oc','executor','template','lead','created','now','now')", []).unwrap();
    store.set_permission_level("oc", Some("auto")).unwrap();
    let data = std::fs::canonicalize(dir.path()).unwrap().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let path = crate::executor_temp::ensure_at_start(&store, &data, "oc").unwrap().expect("its temporary directory");
    let given = given(&path);
    (dir, store, given)
}

fn ticket(store: &Store, turn: &str, generation: u64, given: &Given) -> Option<Ticket> {
    issue(store, "oc", "ses_main", turn, generation, given).unwrap()
}

fn usage(store: &Store) -> Option<Value> {
    view(&*store.db.read().unwrap(), "oc").unwrap()
}

#[test]
fn one_ticket_per_turn_and_only_for_an_executor_at_ask_auto_or_full() {
    let (_dir, store, given) = lab();
    let first = ticket(&store, "t1", 1, &given).unwrap();
    assert_eq!((first.revision, first.usable), (1, true));
    assert_eq!(ticket(&store, "t1", 1, &given), None, "the same Turn has had its ticket");
    assert_eq!(ticket(&store, "t1", 2, &given), None, "on a new connection too");
    assert_eq!(ticket(&store, "t2", 1, &given).unwrap().revision, 2, "revisions only grow");
    assert_eq!(usage(&store), None, "a ticket is not a result: nothing measured yet");
    for level in [Some("read-only"), None] {
        store.set_permission_level("oc", level).unwrap();
        assert_eq!(ticket(&store, &format!("t-{level:?}"), 1, &given), None, "{level:?}");
    }
    store.set_permission_level("oc", Some("ask")).unwrap();
    store.db.write().unwrap().execute("DELETE FROM agent_roles WHERE agent_id='oc'", []).unwrap();
    assert_eq!(ticket(&store, "t-standing", 1, &given), None, "a standing Agent");
}

#[test]
fn only_the_latest_ticket_writes_and_an_older_result_is_dropped() {
    let (_dir, store, given) = lab();
    let old = ticket(&store, "t1", 1, &given).unwrap();
    let new = ticket(&store, "t2", 1, &given).unwrap();
    assert_eq!(write_back(&store, &new, Sample::Measured(4096)).unwrap(), Some(2));
    assert_eq!(write_back(&store, &old, Sample::Measured(1)).unwrap(), None, "an older result never overwrites a newer one");
    assert_eq!(write_back(&store, &old, Sample::Unknown(Unknown::Timeout)).unwrap(), None);
    let shown = usage(&store).unwrap();
    assert_eq!((shown["revision"].as_i64(), shown["state"].as_str(), shown["bytes"].as_i64()), (Some(2), Some("measured"), Some(4096)));
    // A new connection's ticket: what the old one measured is dropped.
    let before = ticket(&store, "t3", 1, &given).unwrap();
    let after = ticket(&store, "t4", 2, &given).unwrap();
    assert_eq!(write_back(&store, &before, Sample::Measured(9)).unwrap(), None);
    assert_eq!(write_back(&store, &after, Sample::Measured(8192)).unwrap(), Some(4));
    // A ticket for another directory never writes over this one's.
    let mut forged = after.clone();
    forged.given.ino += 1;
    assert_eq!(write_back(&store, &forged, Sample::Measured(1)).unwrap(), None);
    assert_eq!(usage(&store).unwrap()["bytes"], 8192);
}

#[test]
fn a_replaced_or_released_directory_keeps_no_byte_count() {
    let (_dir, store, given) = lab();
    let t = ticket(&store, "t1", 1, &given).unwrap();
    assert_eq!(write_back(&store, &t, Sample::Measured(512)).unwrap(), Some(1));
    // The record names another directory now: a count for this ticket is dropped.
    let t2 = ticket(&store, "t2", 1, &given).unwrap();
    store.db.write().unwrap().execute("UPDATE executor_temp_dirs SET ino=ino+1 WHERE agent_id='oc'", []).unwrap();
    assert_eq!(write_back(&store, &t2, Sample::Measured(1024)).unwrap(), None);
    assert_eq!(usage(&store).unwrap()["bytes"], 512, "the last result stands");
    // A ticket made then is unusable from the start, and reads nothing.
    let t3 = ticket(&store, "t3", 1, &given).unwrap();
    assert!(!t3.usable);
    store.db.write().unwrap().execute("UPDATE executor_temp_dirs SET ino=ino-1 WHERE agent_id='oc'", []).unwrap();
    // Released: only an unknown is written.
    crate::executor_temp::release_for_close(&store.db.write().unwrap(), "oc", "released-at").unwrap();
    let t4 = ticket(&store, "t4", 1, &given).unwrap();
    assert!(!t4.usable, "released");
    assert_eq!(write_back(&store, &t4, Sample::Measured(2048)).unwrap(), None);
    assert_eq!(write_back(&store, &t4, Sample::Unknown(Unknown::Unavailable)).unwrap(), Some(4));
    let shown = usage(&store).unwrap();
    assert_eq!((shown["state"].as_str(), shown["bytes"].is_null(), shown["reason"].as_str()), (Some("unknown"), true, Some("unavailable")));
    assert_eq!(shown["lastMeasured"]["bytes"], 512, "the last byte count apart, with its own time");
    assert!(shown["lastMeasured"]["at"].is_string());
}

#[test]
fn what_the_overview_reads_never_shows_zero_for_unknown_and_says_the_soft_line() {
    let (dir, store, given) = lab();
    let t = ticket(&store, "t1", 1, &given).unwrap();
    write_back(&store, &t, Sample::Unknown(Unknown::Busy)).unwrap();
    let shown = usage(&store).unwrap();
    assert_eq!(shown, json!({"revision": 1, "state": "unknown", "bytes": null, "reason": "busy", "at": shown["at"],
        "limitBytes": SOFT_LIMIT_BYTES}), "no byte count, no last count: never 0");
    for (bytes, over_it) in [(SOFT_LIMIT_BYTES - 512, false), (SOFT_LIMIT_BYTES, true)] {
        let t = ticket(&store, &format!("t-{bytes}"), 1, &given).unwrap();
        write_back(&store, &t, Sample::Measured(bytes)).unwrap();
        let shown = usage(&store).unwrap();
        assert_eq!((shown["bytes"].as_i64(), shown["over"].as_bool(), shown["limitBytes"].as_i64()), (Some(bytes), Some(over_it), Some(SOFT_LIMIT_BYTES)));
    }
    // The executor's detail carries it under its temporary directory.
    let temp = crate::executor_temp::view(&*store.db.read().unwrap(), "oc").unwrap().unwrap();
    assert_eq!(temp["usage"]["bytes"], SOFT_LIMIT_BYTES);
    // No file name is ever stored.
    std::fs::write(given.path.join("synthetic-secret-name"), b"x").unwrap();
    let t = ticket(&store, "t-named", 1, &given).unwrap();
    write_back(&store, &t, walked(&given)).unwrap();
    let rows: String = store.db.read().unwrap().query_row("SELECT json_group_array(json_array(session,turn,state,reason)) FROM executor_temp_usage", [], |r| r.get(0)).unwrap();
    assert!(!rows.contains("synthetic-secret-name"), "{rows}");
    // A restart reads the same result and measures nothing again: there is no queue.
    let unfinished = ticket(&store, "t-unfinished", 1, &given).unwrap();
    drop(store);
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let shown = usage(&store).unwrap();
    assert_ne!(shown["revision"].as_i64(), Some(unfinished.revision), "a ticket left without a result is not shown as one");
    assert_eq!(ticket(&store, "t-unfinished", 1, &given), None, "and is not made again");
}
