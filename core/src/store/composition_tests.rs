//! The held Agents' stored history composition (T-140, history_composition).

use super::tests::{detail, lab, stream};
use super::*;
use crate::history_composition::{composition, BUDGET};
use std::time::Duration;

/// A Turn with a reply (conversation text, kept in its Item row) and a
/// command whose output is a payload; both in multi-byte text, so stored
/// bytes and characters differ.
fn record(id: &str, output_chars: usize) -> AgentDetail {
    let mut d = detail(id);
    d.turns = vec![json!({"id":"t","status":"completed","items":[
        {"id":"reply","type":"agentMessage","text":"é".repeat(3000)},
        {"id":"cmd","type":"commandExecution","command":"ls","status":"completed","aggregatedOutput":"日本".repeat(output_chars / 2)}
    ]})];
    d
}

/// Bytes of a column as SQLite stores them, counted independently of the
/// function under test (a BLOB's length is its bytes).
fn stored(store: &Store, sql: &str) -> (u64, u64) {
    store.db.read().unwrap().query_row(sql, [], |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64))).unwrap()
}

#[test]
fn held_agents_are_measured_in_stored_bytes_with_their_unwritten_changes() {
    let (_dir, store) = lab();
    store.insert(&record("a", 40_000)).unwrap();
    store.insert(&record("b", 40_000)).unwrap();
    // Only "a" streams, so only "a" is held; its delta is not written yet.
    stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":" more"}));
    let held = store.held_agents();
    assert_eq!(held.len(), 1);
    assert_eq!((held[0].id.as_str(), held[0].name.as_deref(), held[0].unwritten), ("a", Some("a"), true));

    let report = composition(&store, BUDGET);
    assert_eq!(report["available"], true, "{report}");
    assert_eq!(report["heldAgents"], 1);
    let a = &report["agents"][0];
    assert_eq!((a["agentId"].as_str(), a["stored"].as_bool(), a["unwrittenChanges"].as_bool()), (Some("a"), Some(true), Some(true)));
    assert_eq!(a["layout"], 1);
    // Each part against the rows' own bytes, read as BLOBs.
    let (rows, bytes) = stored(&store, "SELECT count(*), sum(length(CAST(data AS BLOB))) FROM agent_payloads WHERE agent_id='a'");
    assert_eq!((a["payloads"]["rows"].as_u64(), a["payloads"]["bytes"].as_u64()), (Some(rows), Some(bytes)));
    assert_eq!(rows, 1, "the command output is the one payload");
    let (rows, bytes) = stored(&store, "SELECT count(*), sum(length(CAST(data AS BLOB))) FROM agent_items WHERE agent_id='a'");
    assert_eq!((a["items"]["rows"].as_u64(), a["items"]["bytes"].as_u64()), (Some(rows), Some(bytes)));
    let (rows, bytes) = stored(&store, "SELECT count(previews), coalesce(sum(length(CAST(previews AS BLOB))),0) FROM agent_items WHERE agent_id='a'");
    assert_eq!((a["previews"]["rows"].as_u64(), a["previews"]["bytes"].as_u64()), (Some(rows), Some(bytes)));
    assert_eq!(a["itemsWithPayloads"], 1);
    let (rows, bytes) = stored(&store, "SELECT count(*), sum(length(CAST(data AS BLOB))) FROM agent_turns WHERE agent_id='a'");
    assert_eq!((a["turns"]["rows"].as_u64(), a["turns"]["bytes"].as_u64()), (Some(rows), Some(bytes)));
    let (_, bytes) = stored(&store, "SELECT 1, length(CAST(data AS BLOB)) FROM agents WHERE id='a'");
    assert_eq!(a["metadata"]["bytes"].as_u64(), Some(bytes));
    // Bytes, not characters: the payload is three bytes a character.
    let (chars, bytes) = stored(&store, "SELECT sum(length(data)), sum(length(CAST(data AS BLOB))) FROM agent_payloads WHERE agent_id='a'");
    assert!(bytes > 2 * chars, "{bytes} bytes for {chars} characters");
    // The total is the one held Agent's; "b" is not held and not counted.
    assert_eq!(report["total"]["payloads"], a["payloads"]);
    assert_eq!(report["agents"].as_array().unwrap().len(), 1);
    // Nothing of the record's text is in the answer.
    assert!(!report.to_string().contains("日本") && !report.to_string().contains("ééé"));
}

#[test]
fn a_held_agent_without_rows_is_said_and_not_counted() {
    let (_dir, store) = lab();
    store.insert(&record("a", 20_000)).unwrap();
    stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":" more"}));
    // Its rows are gone (as for an Agent deleted between the two reads).
    store.db.write().unwrap().execute("DELETE FROM agents WHERE id='a'", []).unwrap();
    let report = composition(&store, BUDGET);
    assert_eq!(report["available"], true, "{report}");
    assert_eq!(report["agents"][0]["stored"], false);
    assert_eq!(report["total"]["payloads"]["rows"], 0);
}

#[test]
fn past_its_budget_nothing_is_given_and_the_connection_is_left_clean() {
    let (_dir, store) = lab();
    let mut d = detail("a");
    // Enough Item rows that the statements take many more steps than STEPS.
    d.turns = (0..40).map(|t| json!({"id":format!("t{t}"),"status":"completed","items":
        (0..100).map(|i| json!({"id":format!("i{i}"),"type":"agentMessage","text":"x"})).collect::<Vec<_>>()})).collect();
    store.insert(&d).unwrap();
    stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"t39","itemId":"i0","delta":"y"}));
    let report = composition(&store, Duration::ZERO);
    assert_eq!(report["available"], false, "{report}");
    assert!(report["reason"].as_str().unwrap().contains("Not read within 0 ms"), "{report}");
    assert!(report.get("agents").is_none() && report.get("total").is_none(), "no partial numbers: {report}");
    // The pooled connection was given back without the handler: a read that
    // takes many more steps than STEPS, on the same connection, runs to the
    // end (it is the one the pool hands out next).
    let rows: i64 = store.db.read().unwrap()
        .query_row("SELECT count(*) FROM agent_items WHERE agent_id='a' AND length(data) > 0", [], |r| r.get(0)).unwrap();
    assert_eq!(rows, 4000);
    let again = composition(&store, BUDGET);
    assert_eq!(again["available"], true, "{again}");
    assert_eq!(again["agents"][0]["items"]["rows"], 4000);
}

/// Pages a connection's cache had to read, since it opened.
fn cache_misses(db: &Connection) -> i32 {
    let (mut current, mut highest) = (0, 0);
    // SAFETY: a valid open handle and two out parameters, as documented.
    let rc = unsafe {
        rusqlite::ffi::sqlite3_db_status(db.handle(), rusqlite::ffi::SQLITE_DBSTATUS_CACHE_MISS, &mut current, &mut highest, 0)
    };
    assert_eq!(rc, rusqlite::ffi::SQLITE_OK);
    current
}

/// Pages a new connection reads for `read` (its page cache starts empty),
/// and what `read` gave.
fn pages_read<T>(db: Connection, read: impl FnOnce(&Connection) -> T) -> (i64, T) {
    let before = cache_misses(&db);
    let out = read(&db);
    (i64::from(cache_misses(&db) - before), out)
}

#[test]
fn stored_bytes_are_read_from_row_headers_not_from_the_payloads() {
    let (dir, store) = lab();
    let mut d = detail("a");
    // 24 commands, each with nine fields over TRIM_ABOVE: their payloads are
    // on overflow pages, and so are most of each Item's nine previews of
    // about 4 KiB, the last column of its row.
    let big = |c: char, n: usize| c.to_string().repeat(n);
    d.turns = vec![json!({"id":"t","status":"completed","items":(0..24).map(|i| {
        let mut item = json!({"id":format!("c{i}"),"type":"commandExecution","command":"x","status":"completed",
            "aggregatedOutput":big('z', 256 * 1024)});
        for f in 0..8 {
            item[format!("f{f}")] = json!(big(char::from(b'a' + f), 32 * 1024));
        }
        item
    }).collect::<Vec<_>>()})];
    store.insert(&d).unwrap();
    drop(store);
    let path = dir.path().join("workspace.sqlite");
    let open = || Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let count = |sql: &str| -> i64 { open().query_row(sql, [], |r| r.get(0)).unwrap() };
    // The pages of the four tables, their indexes and the schema, other than
    // overflow pages: all that reading the rows' headers can need.
    let tables = "('agents','agent_turns','agent_items','agent_payloads')";
    let rows = count(&format!("SELECT count(*) FROM dbstat WHERE pagetype != 'overflow' AND (name IN {tables}
        OR name = 'sqlite_schema' OR name IN (SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name IN {tables}))"));
    let overflow = |table: &str| count(&format!("SELECT count(*) FROM dbstat WHERE name='{table}' AND pagetype='overflow'"));
    let (previews, payloads) = (overflow("agent_items"), overflow("agent_payloads"));
    assert!(previews > rows && payloads > 10 * rows, "the fixture's large values outweigh the rest: {previews} and {payloads} overflow pages, {rows} others");
    // Reading the previews shows: length() of TEXT reads them.
    let (reading, characters) = pages_read(open(), |db| db.query_row::<i64, _, _>("SELECT sum(length(previews)) FROM agent_items", [], |r| r.get(0)).unwrap());
    assert!(reading >= previews, "length() reads the previews: {reading} pages, {previews} of them overflow");
    // What the report reads, through its own statements.
    let (read, found) = pages_read(open(), |db| crate::history_composition::one(db, "a").unwrap().unwrap());
    assert_eq!((found.payloads.rows, found.previews.rows, found.items_with_payloads), (24 * 9, 24, 24));
    // ASCII: as many bytes as characters.
    assert_eq!(found.previews.bytes, characters as u64);
    assert!(found.payloads.bytes > 24 * (256 + 8 * 32) * 1024);
    assert!(read <= rows, "the report reads no overflow page: {read} pages, of {rows} besides {previews} + {payloads} overflow");
}
