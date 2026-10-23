//! The completion index (T-140): `Store::open` makes it when it is missing,
//! within a budget and without waiting for a lock, leaves one that is there
//! alone, and opens the Workspace whatever happens to it; with or without it,
//! the completion check finds the same.
use super::tests::{detail, lab};
use super::*;

const NAME: &str = "journal_turn_completed";

/// A recovered completion's journal data, as the store writes it.
fn completion(turn: &str) -> String {
    json!({"turn":{"id":turn,"status":"completed","items":[]},"recovered":true}).to_string()
}

fn completions(n: usize) -> Vec<String> {
    (0..n).map(|i| completion(&format!("t{i}"))).collect()
}

/// A Workspace as an older Core left it: no completion index, and these
/// turn/completed rows of Agent `a`.
fn older(rows: &[String]) -> (tempfile::TempDir, std::path::PathBuf) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("workspace.sqlite");
    drop(Store::open(&path).unwrap());
    let db = Connection::open(&path).unwrap();
    db.execute_batch(&format!("DROP INDEX {NAME}")).unwrap();
    for data in rows {
        db.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a','turn/completed',?1,'2026-10-23T00:00:00Z')", [data]).unwrap();
    }
    (dir, path)
}

/// The index's root page, if it is there (a rebuild would make a new one).
fn root(db: &Connection) -> Option<i64> {
    db.query_row("SELECT rootpage FROM sqlite_master WHERE type='index' AND name=?1", [NAME], |r| r.get(0)).optional().unwrap()
}

/// The completion check for Agent `a`, as the writer's commit makes it.
fn check(db: &Connection, turn: &str) -> std::result::Result<bool, String> {
    completed_before(db, "a", "turn/completed", &json!({"turn":{"id":turn}})).map_err(|e| format!("{e:#}"))
}

fn busy_timeout_ms(db: &Connection) -> i64 {
    db.query_row("PRAGMA busy_timeout", [], |r| r.get(0)).unwrap()
}

fn integrity(db: &Connection) -> String {
    db.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap()
}

#[test]
fn an_older_journal_gets_the_index_as_it_opens_and_the_check_uses_it() {
    let (_dir, path) = older(&completions(50));
    let store = Store::open(&path).unwrap();
    let db = store.db.read().unwrap();
    assert!(root(&db).is_some());
    let plan: Vec<String> = db.prepare(&format!("EXPLAIN QUERY PLAN {COMPLETED}")).unwrap()
        .query_map(params!["a", "t1"], |r| r.get(3)).unwrap().collect::<rusqlite::Result<_>>().unwrap();
    assert!(plan.iter().any(|step| step.contains("USING INDEX journal_turn_completed")), "{plan:?}");
    assert_eq!(check(&db, "t49"), Ok(true));
    assert_eq!(check(&db, "t50"), Ok(false));
}

#[test]
fn an_index_already_there_is_neither_made_again_nor_read() {
    let (_dir, path) = older(&completions(50));
    drop(Store::open(&path).unwrap());
    let db = Connection::open(&path).unwrap();
    let made = root(&db);
    assert!(made.is_some());
    // A spent budget would stop any build at its first check: none is tried.
    assert_eq!(completion_index(&db, Duration::ZERO).unwrap(), CompletionIndex::Present);
    drop(db);
    drop(Store::open(&path).unwrap());
    assert_eq!(root(&Connection::open(&path).unwrap()), made);
}

#[test]
fn a_spent_budget_stops_the_build_and_leaves_no_index_and_the_connection_as_it_was() {
    let (_dir, path) = older(&completions(3000));
    let db = Connection::open(&path).unwrap();
    db.busy_timeout(BUSY_TIMEOUT).unwrap();
    // Already spent: SQLite stops the build at its first check, after
    // COMPLETION_INDEX_STEPS steps, which 3000 rows take many times over.
    let outcome = completion_index(&db, Duration::ZERO).unwrap();
    assert!(matches!(&outcome, CompletionIndex::Missing(reason) if reason.contains("interrupt")), "{outcome:?}");
    assert_eq!(root(&db), None);
    assert!(db.is_autocommit());
    assert_eq!(integrity(&db), "ok");
    assert_eq!(busy_timeout_ms(&db), 3000);
    // No progress handler is left to stop a statement of as many steps.
    let counted: i64 = db.query_row("SELECT COUNT(*) FROM journal WHERE json_extract(data,'$.turn.id') IS NOT NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(counted, 3000);
    db.execute_batch("BEGIN IMMEDIATE").unwrap();
    db.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a','turn/completed',?1,'now')", [completion("late")]).unwrap();
    db.execute_batch("COMMIT").unwrap();
    assert_eq!(check(&db, "late"), Ok(true));
    assert_eq!(check(&db, "t2999"), Ok(true));
    assert_eq!(check(&db, "missing"), Ok(false));
}

#[test]
fn history_that_is_not_json_opens_unindexed_and_the_check_finds_what_it_did() {
    let (_dir, path) = older(&[completion("t1"), "not json".to_owned(), completion("t9")]);
    // The same journal, never offered the index: what the check finds today.
    let today = Connection::open(&path).unwrap();
    let expected = [check(&today, "t1"), check(&today, "t9"), check(&today, "missing")];
    drop(today);
    assert!(expected[0] == Ok(true) && expected[1].as_ref().is_err_and(|e| e.contains("malformed JSON")), "{expected:?}");
    let store = Store::open(&path).unwrap();
    let db = store.db.read().unwrap();
    assert_eq!(root(&db), None);
    assert_eq!([check(&db, "t1"), check(&db, "t9"), check(&db, "missing")], expected);
    assert_eq!(busy_timeout_ms(&db), 3000);
}

#[test]
fn a_journal_another_connection_is_writing_is_not_waited_for() {
    let (_dir, path) = older(&completions(50));
    let holder = Connection::open(&path).unwrap();
    holder.execute_batch("BEGIN IMMEDIATE").unwrap();
    let db = Connection::open(&path).unwrap();
    db.busy_timeout(BUSY_TIMEOUT).unwrap();
    let at = Instant::now();
    let outcome = completion_index(&db, COMPLETION_INDEX_BUDGET).unwrap();
    // Not the busy timeout a writer would wait for the lock.
    assert!(at.elapsed() < BUSY_TIMEOUT, "{:?}", at.elapsed());
    assert!(matches!(&outcome, CompletionIndex::Missing(reason) if reason.contains("locked")), "{outcome:?}");
    assert_eq!(busy_timeout_ms(&db), 3000);
    holder.execute_batch("ROLLBACK").unwrap();
    assert_eq!(root(&db), None);
    assert_eq!(completion_index(&db, COMPLETION_INDEX_BUDGET).unwrap(), CompletionIndex::Made);
}

#[test]
fn a_full_disk_leaves_no_index() {
    let (_dir, path) = older(&completions(50));
    let db = Connection::open(&path).unwrap();
    let pages: i64 = db.query_row("PRAGMA page_count", [], |r| r.get(0)).unwrap();
    // No page more than the database has now (this connection only).
    db.query_row(&format!("PRAGMA max_page_count={pages}"), [], |_| Ok(())).unwrap();
    let outcome = completion_index(&db, COMPLETION_INDEX_BUDGET).unwrap();
    assert!(matches!(&outcome, CompletionIndex::Missing(reason) if reason.contains("full")), "{outcome:?}");
    assert_eq!(root(&db), None);
    db.query_row("PRAGMA max_page_count=1073741823", [], |_| Ok(())).unwrap();
    assert_eq!(integrity(&db), "ok");
    assert_eq!(check(&db, "t1"), Ok(true));
}

/// The same story in a store with the index and in one without it until it
/// reopens: a recovered completion (twice), a live completion of a Turn
/// already completed (a reconfirmation), a completion written in a
/// transaction that rolls back, a Codex import, a recovered batch, then a
/// restart. What the journal, the unread count and the check say.
fn story(indexed: bool) -> Value {
    let (dir, store) = lab();
    if !indexed {
        store.db.write().unwrap().execute_batch(&format!("DROP INDEX {NAME}")).unwrap();
    }
    let mut d = detail("a");
    d.turns = vec![json!({"id":"t1","status":"completed","items":[]}), json!({"id":"t2","status":"completed","items":[]}),
        json!({"id":"imported","status":"completed","items":[]})];
    store.insert(&d).unwrap();
    store.record_recovered_completion("a", &d.turns[0]).unwrap();
    store.record_recovered_completion("a", &d.turns[0]).unwrap();
    let event = json!({"turn":{"id":"t1","status":"completed","items":[]}});
    store.record_event("a", "turn/completed", &event, |d| d.apply("turn/completed", &event)).unwrap();
    let rolled_back = {
        let db = store.db.write().unwrap();
        db.execute_batch("BEGIN").unwrap();
        db.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a','turn/completed',?1,'now')", [completion("t2")]).unwrap();
        let inside = check(&db, "t2");
        db.execute_batch("ROLLBACK").unwrap();
        (inside, check(&db, "t2"))
    };
    store.db.write().unwrap().execute("INSERT INTO codex_imports(agent_id,thread_id,awaiting_handoff) VALUES('a','thread',0)", []).unwrap();
    store.db.write().unwrap().execute("INSERT INTO codex_import_turns(agent_id,turn_id) VALUES('a','imported')", []).unwrap();
    store.record_recovered_completions("a", &d.turns).unwrap();
    let journal: Vec<(String, Option<String>)> = {
        let db = store.db.read().unwrap();
        let mut q = db.prepare("SELECT kind, json_extract(data,'$.turn.id') FROM journal WHERE agent_id='a' ORDER BY seq").unwrap();
        q.query_map([], |r| Ok((r.get(0)?, r.get(1)?))).unwrap().collect::<rusqlite::Result<_>>().unwrap()
    };
    let unread = store.agent("a").unwrap().unread_count;
    let present = root(&store.db.read().unwrap()).is_some();
    drop(store);
    let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
    let db = store.db.read().unwrap();
    let after_restart: Vec<_> = ["t1", "t2", "imported", "missing"].iter().map(|t| check(&db, t)).collect();
    assert_eq!(present, indexed);
    json!({"journal":journal,"unread":unread,"rolledBack":format!("{rolled_back:?}"),"afterRestart":format!("{after_restart:?}"),
        "indexedAfterRestart":root(&db).is_some()})
}

#[test]
fn reconfirmations_rollbacks_imports_unread_and_a_restart_are_the_same_with_and_without_the_index() {
    let (with, without) = (story(true), story(false));
    assert_eq!(with, without);
    let kinds = |kind: &str, turn: &str| with["journal"].as_array().unwrap().iter().filter(|row| row == &&json!([kind, turn])).count();
    assert_eq!((kinds("turn/completed", "t1"), kinds("turn/reconfirmed", "t1"), kinds("turn/completed", "t2")), (1, 1, 1), "{with}");
    assert_eq!(kinds("turn/completed", "imported"), 0, "{with}");
    assert_eq!(with["rolledBack"], json!("(Ok(true), Ok(false))"));
    assert_eq!(with["indexedAfterRestart"], json!(true));
}
