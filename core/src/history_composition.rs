//! What the held Agents' stored history is made of (T-140), read only when
//! the user asks for it (GET /api/diagnostics/memory/history), never with
//! /api/health or /api/diagnostics/memory.
//!
//! For each Agent whose record is held (`Store::held_agents`), it counts the
//! rows and sums the bytes the database stores for that record: the metadata
//! row (`agents.data`; with layout 0, the whole record, and no other rows),
//! its Turns, its Items' own data and its payloads (the full large fields).
//! These four are disjoint, and are the record. The previews kept for
//! clients are a shorter copy of payloads, so they are given apart and are
//! not part of the record. The journal, originals kept from before a
//! conversion and salvaged rows are other copies and are not counted. It
//! never reads a record: no row is parsed and no held record is copied or
//! serialized.
//!
//! The bytes are SQLite's own count of each value's bytes in the database's
//! encoding, `octet_length(column)`: UTF-8, SQLite's default, which Core never
//! changes. For a column argument SQLite takes that from the row's header
//! and does not read a value stored on overflow pages (the
//! `OPFLAG_BYTELENARG` case of OP_Column); the leaf pages of the Agent's rows
//! are still read. `length` of TEXT counts characters, so it reads them all,
//! and so does any other use of a column, `count(previews)` included: the
//! previews are counted as `count(octet_length(previews))`.
//! They are what is stored: not the Rust heap a held record takes, String
//! capacity, RSS or SQLite's page cache. A held record may have changes its
//! rows lack yet, so each Agent says whether it had.
//!
//! The held list is read first, then the rows in one read snapshot, so the
//! two are not one atomic view. The rows are read within a budget: a
//! progress handler stops the statement past it, and an Agent's numbers are
//! then not given at all, nor any total, rather than partial ones. Without
//! WAL a read shares the one writer, and measuring would hold up its writes,
//! so it is not measured. A reason is one of this module's own sentences
//! with at most SQLite's error code, never an error's text.

use crate::store::{HeldAgent, Store};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::time::{Duration, Instant};

/// How long the reads may take before they stop.
pub const BUDGET: Duration = Duration::from_secs(2);
/// How many virtual machine steps between checks of the budget.
const STEPS: i32 = 1000;

const NOTE: &str = "Stored bytes: the UTF-8 bytes the Workspace database keeps for each held Agent's record (metadata, Turns, Item text and payloads), counted by SQLite from each row's header without reading large values. Previews are a shorter copy of payloads for clients, given apart and not part of the record. The journal, kept originals and salvaged rows are not counted. They are not the memory the held record takes in Core (its Rust heap or capacity), RSS or SQLite's page cache. For an Agent marked with unwritten changes, this report may differ from its record in memory; that implies no size, nor that they still differ, since its changes may be written between the two reads. The held Agents are listed first and their rows read after, so the two are not one atomic snapshot.";

/// One part of a record: its rows and their stored bytes.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Part {
    pub rows: u64,
    pub bytes: u64,
}

/// What one held Agent's stored record is made of.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Composition {
    /// 1: rows; 0: the whole record in its metadata row.
    pub layout: i64,
    pub metadata: Part,
    pub turns: Part,
    pub items: Part,
    /// Item rows with at least one payload.
    pub items_with_payloads: u64,
    /// The previews kept for clients, in Item rows that have payloads: a
    /// copy of part of the payloads, not part of the record.
    pub previews: Part,
    pub payloads: Part,
}

/// The report: the held Agents' composition, or why it is not available.
pub fn composition(store: &Store, budget: Duration) -> Value {
    let read_at = chrono::Utc::now().to_rfc3339();
    let held = store.held_agents();
    let measured = if !store.db.is_wal() {
        Err("This Workspace database is read through its one writer (no WAL), so measuring it would hold up its writes.".to_string())
    } else {
        store.db.read().map_err(|_| "The Workspace database could not be read now.".to_string())
            .and_then(|read| measure(&read, &held, budget))
    };
    match measured {
        Ok(measured) => {
            let mut total = Composition::default();
            let agents: Vec<Value> = held.iter().zip(&measured).map(|(agent, found)| match found {
                Some(c) => {
                    add(&mut total, c);
                    json!({"agentId":agent.id,"name":agent.name,"unwrittenChanges":agent.unwritten,"stored":true,
                        "layout":c.layout,"metadata":part(c.metadata),"turns":part(c.turns),"items":part(c.items),
                        "itemsWithPayloads":c.items_with_payloads,"previews":part(c.previews),"payloads":part(c.payloads)})
                }
                // Held, but no row yet (a new Agent not yet written) or deleted since.
                None => json!({"agentId":agent.id,"name":agent.name,"unwrittenChanges":agent.unwritten,"stored":false}),
            }).collect();
            json!({"format":1,"readAt":read_at,"available":true,"budgetMs":budget.as_millis() as u64,"note":NOTE,
                "heldAgents":held.len(),"agents":agents,
                "total":{"metadata":part(total.metadata),"turns":part(total.turns),"items":part(total.items),
                    "itemsWithPayloads":total.items_with_payloads,"previews":part(total.previews),"payloads":part(total.payloads)}})
        }
        Err(reason) => json!({"format":1,"readAt":read_at,"available":false,"reason":reason,
            "budgetMs":budget.as_millis() as u64,"note":NOTE,"heldAgents":held.len()}),
    }
}

/// The report while another measurement runs.
pub fn busy() -> Value {
    json!({"format":1,"readAt":chrono::Utc::now().to_rfc3339(),"available":false,
        "reason":"Another measurement is running; ask again once it has finished.",
        "budgetMs":BUDGET.as_millis() as u64,"note":NOTE})
}

/// The budget's progress handler, set on a connection. It is removed when
/// this is dropped, a panic included, so the pooled connection goes back
/// without it: left there, its passed deadline would stop every statement
/// the connection runs after.
struct Budget<'a> {
    db: &'a Connection,
    set: bool,
}

impl<'a> Budget<'a> {
    fn set(db: &'a Connection, budget: Duration) -> rusqlite::Result<Self> {
        let deadline = Instant::now() + budget;
        db.progress_handler(STEPS, Some(move || Instant::now() >= deadline))?;
        Ok(Budget { db, set: true })
    }

    fn remove(mut self) -> rusqlite::Result<()> {
        self.set = false;
        clear(self.db)
    }
}

impl Drop for Budget<'_> {
    fn drop(&mut self) {
        if self.set {
            let _ = clear(self.db);
        }
    }
}

fn clear(db: &Connection) -> rusqlite::Result<()> {
    db.progress_handler(0, None::<fn() -> bool>)
}

/// Each held Agent's stored composition (None: no row), all within the
/// budget, or the reason they were not read.
fn measure(db: &Connection, held: &[HeldAgent], budget: Duration) -> Result<Vec<Option<Composition>>, String> {
    let budget_set = Budget::set(db, budget).map_err(|_| "The budget could not be set, so nothing was read.".to_string())?;
    let read: rusqlite::Result<Vec<Option<Composition>>> = held.iter().map(|agent| one(db, &agent.id)).collect();
    let removed = budget_set.remove();
    match (read, removed) {
        (_, Err(_)) => Err("The budget could not be removed, so nothing is given.".to_string()),
        (Ok(measured), Ok(())) => Ok(measured),
        (Err(rusqlite::Error::SqliteFailure(error, _)), Ok(())) if error.code == rusqlite::ErrorCode::OperationInterrupted =>
            Err(format!("Not read within {} ms, so no part of it is given.", budget.as_millis())),
        (Err(rusqlite::Error::SqliteFailure(error, _)), Ok(())) =>
            Err(format!("The rows could not be read (SQLite {:?}), so no part of them is given.", error.code)),
        (Err(_), Ok(())) => Err("The rows could not be read, so no part of them is given.".to_string()),
    }
}

/// One Agent's stored composition, None without its metadata row. No
/// statement reads a large value itself: every column whose value can be
/// large is read only as `octet_length(column)`.
pub(crate) fn one(db: &Connection, id: &str) -> rusqlite::Result<Option<Composition>> {
    let Some((layout, metadata)) = db.query_row(
        "SELECT layout, octet_length(data) FROM agents WHERE id=?1", params![id],
        |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?.unwrap_or(0))),
    ).optional()? else {
        return Ok(None);
    };
    let pair = |sql: &str| db.query_row(sql, params![id], |r| Ok(Part { rows: count(r.get(0)?), bytes: count(r.get(1)?) }));
    let turns = pair("SELECT count(*), coalesce(sum(octet_length(data)),0) FROM agent_turns WHERE agent_id=?1")?;
    let payloads = pair("SELECT count(*), coalesce(sum(octet_length(data)),0) FROM agent_payloads WHERE agent_id=?1")?;
    let (items, items_with_payloads, previews) = db.query_row(
        "SELECT count(*), coalesce(sum(octet_length(data)),0), count(octet_length(previews)),
            coalesce(sum(octet_length(previews)),0), coalesce(sum(payloads > 0),0) FROM agent_items WHERE agent_id=?1",
        params![id],
        |r| Ok((Part { rows: count(r.get(0)?), bytes: count(r.get(1)?) }, count(r.get(4)?),
            Part { rows: count(r.get(2)?), bytes: count(r.get(3)?) })),
    )?;
    Ok(Some(Composition { layout, metadata: Part { rows: 1, bytes: count(metadata) }, turns, items, items_with_payloads, previews, payloads }))
}

fn count(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

fn part(p: Part) -> Value {
    json!({"rows":p.rows,"bytes":p.bytes})
}

fn add(total: &mut Composition, c: &Composition) {
    for (sum, p) in [(&mut total.metadata, c.metadata), (&mut total.turns, c.turns), (&mut total.items, c.items),
        (&mut total.previews, c.previews), (&mut total.payloads, c.payloads)] {
        sum.rows += p.rows;
        sum.bytes += p.bytes;
    }
    total.items_with_payloads += c.items_with_payloads;
}
