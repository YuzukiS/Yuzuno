//! Record rows on a copy of a real Workspace database (never the live file):
//! how long converting takes and what it does to the file size, then the
//! cost of each record operation on the largest record, in the profile this
//! is built with (debug, as Core runs).
//!
//! cargo run -p yuzuno-workspace --example record_rows_bench -- <copy.sqlite> <work dir>
//!
//! The copy is only read. Everything written goes to two copies of it made
//! in the work directory with VACUUM INTO.
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{json, Value};
use std::{path::Path, time::Instant};
use yuzuno_workspace::model::AgentDetail;
use yuzuno_workspace::record_rows::{self as rows, Dirty, Step};

const RUNS: usize = 9;

fn ms(since: Instant) -> f64 {
    since.elapsed().as_secs_f64() * 1000.0
}

/// Median and fastest of RUNS runs, in ms.
fn time(mut run: impl FnMut() -> Result<()>) -> Result<(f64, f64)> {
    let mut samples = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let start = Instant::now();
        run()?;
        samples.push(ms(start));
    }
    samples.sort_by(f64::total_cmp);
    Ok((samples[RUNS / 2], samples[0]))
}

fn open(path: &Path) -> Result<Connection> {
    let db = Connection::open(path)?;
    db.busy_timeout(std::time::Duration::from_secs(3))?;
    // As Store::open's main connection.
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
    rows::migrate(&db)?;
    Ok(db)
}

fn file_size(path: &Path) -> u64 {
    let wal = path.with_extension("sqlite-wal");
    std::fs::metadata(path).map(|m| m.len()).unwrap_or(0) + std::fs::metadata(wal).map(|m| m.len()).unwrap_or(0)
}

fn tables(db: &Connection) -> Result<Vec<(String, i64)>> {
    let mut query = db.prepare("SELECT name, SUM(pgsize) FROM dbstat GROUP BY name ORDER BY 2 DESC")?;
    let rows = query.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn pages(db: &Connection) -> Result<(i64, i64, i64)> {
    let get = |pragma: &str| db.query_row(&format!("PRAGMA {pragma}"), [], |r| r.get::<_, i64>(0));
    Ok((get("page_size")?, get("page_count")?, get("freelist_count")?))
}

fn mib(bytes: f64) -> String {
    format!("{:.1} MiB", bytes / 1024.0 / 1024.0)
}

/// Appends to an Item's largest string field (or adds one), so the write
/// that follows has something to write.
fn touch(item: &mut Value, n: usize) {
    let field = ["aggregatedOutput", "output", "text"].into_iter().find(|f| item[*f].is_string()).unwrap_or("_benchTouch");
    let mut text = item[field].as_str().unwrap_or_default().to_owned();
    text.push_str(&format!("\nbench {n}"));
    item[field] = text.into();
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let source = args.next().context("usage: record_rows_bench <copy.sqlite> <work dir>")?;
    let work = std::path::PathBuf::from(args.next().context("usage: record_rows_bench <copy.sqlite> <work dir>")?);
    std::fs::create_dir_all(&work)?;
    let original = Connection::open_with_flags(&source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let converted_path = work.join("converted.sqlite");
    let whole_path = work.join("whole.sqlite");
    for path in [&converted_path, &whole_path] {
        for suffix in ["", "-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{suffix}", path.display()));
        }
        original.execute("VACUUM INTO ?1", [path.to_str().unwrap()])?;
    }
    for entry in std::fs::read_dir(&work)? {
        let path = entry?.path();
        if path.to_string_lossy().contains(".before-record-rows-") {
            std::fs::remove_file(path)?;
        }
    }
    let mut report = json!({"source": source});

    // ---- Converting
    let mut db = open(&converted_path)?;
    let (page, count, free) = pages(&db)?;
    let before_tables = tables(&db)?;
    let before_file = file_size(&converted_path);
    println!("Before: file {} ({} pages of {page} B, {free} free)", mib(before_file as f64), count);
    let records: Vec<(String, i64)> = db.prepare("SELECT id, length(CAST(data AS BLOB)) FROM agents ORDER BY rowid")?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut last = Instant::now();
    let mut steps = Vec::new();
    let start = Instant::now();
    let conversion = rows::convert_with(&mut db, &converted_path, |step| {
        let taken = ms(last);
        match step {
            Step::BackedUp(path) => steps.push(("backup".to_owned(), taken, file_size(path) as i64)),
            Step::Converted(id) => {
                let bytes = records.iter().find(|(r, _)| r == id).map_or(0, |(_, b)| *b);
                steps.push((id[..8].to_owned(), taken, bytes));
            }
            Step::Checked(_) | Step::BackingUp(_) => return Ok(()),
        }
        last = Instant::now();
        Ok(())
    })?;
    let total = ms(start);
    anyhow::ensure!(conversion.failed.is_empty(), "failed: {:?}", conversion.failed);
    println!("Converted {} Agents in {total:.0} ms (one transaction each, checked):", conversion.converted.len());
    for (what, taken, bytes) in &steps {
        println!("  {what:<10} {taken:>8.0} ms  {}", mib(*bytes as f64));
    }
    db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
    let (_, count_after, free_after) = pages(&db)?;
    let after_file = file_size(&converted_path);
    let after_tables = tables(&db)?;
    let compact = work.join("compact.sqlite");
    let _ = std::fs::remove_file(&compact);
    db.execute("VACUUM INTO ?1", [compact.to_str().unwrap()])?;
    let compact_size = std::fs::metadata(&compact)?.len();
    std::fs::remove_file(&compact)?;
    println!("After: file {} ({count_after} pages, {free_after} free); compacted {}", mib(after_file as f64), mib(compact_size as f64));
    let wanted = ["agents", "agent_turns", "agent_items", "agent_payloads", "journal"];
    for (name, bytes) in before_tables.iter().filter(|(n, _)| wanted.contains(&n.as_str())) {
        let after = after_tables.iter().find(|(n, _)| n == name).map_or(0, |(_, b)| *b);
        println!("  table {name:<15} before {:>10}  after {:>10}", mib(*bytes as f64), mib(after as f64));
    }
    for (name, bytes) in after_tables.iter().filter(|(n, _)| n.starts_with("agent_") || n.contains("autoindex_agent")) {
        if !wanted.contains(&name.as_str()) {
            println!("  index {name:<30} {:>10}", mib(*bytes as f64));
        }
    }
    let sums: Vec<(String, i64, i64)> = ["agents", "agent_turns", "agent_items", "agent_payloads"].iter().map(|t| {
        let (n, b) = db.query_row(&format!("SELECT COUNT(*), COALESCE(SUM(length(CAST(data AS BLOB))),0) FROM {t}"), [], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(((*t).to_owned(), n, b))
    }).collect::<Result<_>>()?;
    for (table, n, bytes) in &sums {
        println!("  rows {table:<15} {n:>6} rows  {} of data", mib(*bytes as f64));
    }
    report["conversion"] = json!({"ms": total, "steps": steps, "fileBefore": before_file, "fileAfter": after_file,
        "compactedAfter": compact_size, "pagesBefore": count, "pagesAfter": count_after, "freeAfter": free_after,
        "tablesBefore": before_tables, "tablesAfter": after_tables, "rows": sums});

    // ---- Operations on the largest record
    let (id, bytes) = records.iter().max_by_key(|(_, b)| *b).cloned().context("no Agents")?;
    let whole = open(&whole_path)?;
    let raw: String = whole.query_row("SELECT data FROM agents WHERE id=?1", [&id], |r| r.get(0))?;
    let detail: AgentDetail = serde_json::from_str(&raw)?;
    let turn_sizes: Vec<usize> = detail.turns.iter().map(|t| serde_json::to_string(t).map(|s| s.len()).unwrap_or(0)).collect();
    let largest = (0..turn_sizes.len()).max_by_key(|i| turn_sizes[*i]).unwrap();
    let last_turn = detail.turns.len() - 1;
    let items_in = |t: usize| detail.turns[t]["items"].as_array().map_or(0, Vec::len);
    println!("\nLargest record: Agent {} ({}, {} Turns, {} Items); last Turn {} ({} Items), largest Turn {} ({} Items)",
        &id[..8], mib(bytes as f64), detail.turns.len(), (0..detail.turns.len()).map(items_in).sum::<usize>(),
        mib(turn_sizes[last_turn] as f64), items_in(last_turn), mib(turn_sizes[largest] as f64), items_in(largest));
    let mut results: Vec<(String, (f64, f64))> = Vec::new();
    let mut note = |name: &str, t: (f64, f64)| {
        println!("  {name:<58} {:>8.2} ms (fastest {:.2})", t.0, t.1);
        results.push((name.to_owned(), t));
    };

    // Whole-record baseline.
    note("whole: load (SELECT + parse)", time(|| {
        let raw: String = whole.query_row("SELECT data FROM agents WHERE id=?1", [&id], |r| r.get(0))?;
        let _: AgentDetail = serde_json::from_str(&raw)?;
        Ok(())
    })?);
    note("whole: serialize only", time(|| { serde_json::to_string(&detail)?; Ok(()) })?);
    let mut changing = detail.clone();
    let mut n = 0;
    note("whole: write (serialize + UPDATE + synced commit)", time(|| {
        n += 1;
        touch(changing.turns[last_turn]["items"].as_array_mut().unwrap().last_mut().unwrap(), n);
        let tx = whole.unchecked_transaction()?;
        tx.execute("UPDATE agents SET data=?1 WHERE id=?2", params![serde_json::to_string(&changing)?, id])?;
        tx.commit()?;
        Ok(())
    })?);

    // Rows.
    note("rows: read the rows with payloads (SQL only)", time(|| { rows::read(&db, &id, true)?.context("missing")?; Ok(()) })?);
    note("rows: read the rows with previews (SQL only)", time(|| { rows::read(&db, &id, false)?.context("missing")?; Ok(()) })?);
    note("rows: load with payloads (= the record)", time(|| { rows::load(&db, &id, true)?.context("missing")?; Ok(()) })?);
    note("rows: load without payloads", time(|| { rows::load(&db, &id, false)?.context("missing")?; Ok(()) })?);
    let lean = rows::load(&db, &id, false)?.unwrap();
    let lean_bytes = serde_json::to_string(&lean)?.len();
    let last_id = detail.turns[last_turn]["id"].as_str().unwrap().to_owned();
    note("rows: load metadata + last Turn with payloads", time(|| {
        rows::load_meta(&db, &id)?.context("missing")?;
        rows::load_turn(&db, &id, &last_id, true)?.context("missing")?;
        Ok(())
    })?);
    let (payload_turn, payload_item, payload_field, payload_bytes): (String, String, String, i64) = db.query_row(
        "SELECT p.turn_id, p.item_id, p.field, length(CAST(p.data AS BLOB)) FROM agent_payloads p WHERE agent_id=?1 ORDER BY 4 DESC LIMIT 1",
        [&id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
    note(&format!("rows: payloads of one Item ({payload_field}, {})", mib(payload_bytes as f64)), time(|| {
        rows::load_item(&db, &id, Some(&payload_turn), &payload_item, true)?.context("missing")?;
        Ok(())
    })?);
    let (median_turn, median_item): (String, String) = db.query_row(
        "SELECT turn_id, item_id FROM agent_payloads WHERE agent_id=?1 ORDER BY length(CAST(data AS BLOB)) LIMIT 1 OFFSET (SELECT COUNT(*)/2 FROM agent_payloads WHERE agent_id=?1)",
        [&id], |r| Ok((r.get(0)?, r.get(1)?)))?;
    note("rows: payloads of one Item (median payload)", time(|| {
        rows::load_item(&db, &id, Some(&median_turn), &median_item, true)?.context("missing")?;
        Ok(())
    })?);

    let mut current = rows::load(&db, &id, true)?.unwrap();
    for (label, turn, whole_turn) in [("last Turn's row + one Item", last_turn, false), ("whole last Turn", last_turn, true),
        ("whole largest Turn", largest, true)] {
        let turn_id = current.turns[turn]["id"].as_str().unwrap().to_owned();
        let item_index = current.turns[turn]["items"].as_array().unwrap().len() - 1;
        let item_id = current.turns[turn]["items"][item_index]["id"].as_str().unwrap().to_owned();
        let mut dirty = Dirty::default();
        if whole_turn { dirty.whole_turn(&turn_id); } else { dirty.item(&turn_id, &item_id); }
        note(&format!("rows: dirty write, {label} + metadata (synced commit)"), time(|| {
            n += 1;
            touch(&mut current.turns[turn]["items"][item_index], n);
            current.agent.last_seq += 1;
            let tx = db.unchecked_transaction()?;
            rows::write(&tx, &id, &current, &dirty)?;
            tx.commit()?;
            Ok(())
        })?);
    }
    note("rows: write of everything, nothing changed (Dirty::all)", time(|| {
        let tx = db.unchecked_transaction()?;
        rows::write(&tx, &id, &current, &Dirty::all())?;
        tx.commit()?;
        Ok(())
    })?);
    anyhow::ensure!(serde_json::to_string(&rows::load(&db, &id, true)?.unwrap())? == serde_json::to_string(&current)?,
        "rows differ from the record after the writes");

    // Deriving a dirty set for an opaque change (Store::update callers).
    note("dirty set: clone the record (before a change)", time(|| { let _ = current.clone(); Ok(()) })?);
    let before = current.clone();
    let mut after = current.clone();
    touch(&mut after.turns[last_turn]["items"][0], 0);
    note("dirty set: Dirty::between, one Item changed", time(|| {
        let dirty = Dirty::between(&before, &after);
        anyhow::ensure!(dirty.turns().len() == 1);
        Ok(())
    })?);
    let event = json!({"turnId": last_id, "itemId": "x", "delta": "y"});
    note("dirty set: Dirty::of_event", time(|| { Dirty::of_event("item/agentMessage/delta", &event); Ok(()) })?);

    println!("\nWithout payloads the largest record is {} of {} as JSON", mib(lean_bytes as f64), mib(serde_json::to_string(&detail)?.len() as f64));
    report["largest"] = json!({"agent": &id[..8], "bytes": bytes, "turns": detail.turns.len(), "leanBytes": lean_bytes,
        "lastTurnBytes": turn_sizes[last_turn], "largestTurnBytes": turn_sizes[largest], "results": results});
    std::fs::write(work.join("result.json"), serde_json::to_string_pretty(&report)?)?;
    Ok(())
}
