//! Agent records stored as rows.
//!
//! An Agent record (`AgentDetail`) was one JSON row in `agents`, often 5–9 MB,
//! serialized and rewritten whole on every write and parsed whole on every
//! load. Most of it is tool payloads (command output, file changes, tool
//! results), not conversation. Here a record is kept as rows, so a write
//! touches only what changed and a load can leave large payloads out:
//!
//! - `agents.data` with `layout` 1: the record without its Turns (the
//!   metadata). It has no `turns` member, so Core builds from before this
//!   layout refuse to open the Workspace instead of showing empty
//!   conversations. `layout` 0 is the old form: `data` is the whole record.
//! - `agent_turns`, keyed `(agent_id, turn_id)`, ordered by `ord`: each Turn
//!   without its Items (`items` is their count in the row).
//! - `agent_items`, keyed `(agent_id, turn_id, item_id)`, ordered by `ord`
//!   within the Turn: each Item with `null` in place of each large field,
//!   which it notes under `_yuzunoTruncated` (the client view's annotation),
//!   and in `previews` the client view's preview of each. Item IDs repeat
//!   across Turns, so everything is keyed by Turn.
//! - `agent_payloads`, keyed `(agent_id, turn_id, item_id, field)`: the full
//!   value of each large field.
//!
//! A record is assembled with its payloads (exactly the record), or without
//! them, with previews instead: what clients are sent. Neither parses what
//! the other needs: a full load reads no previews, and one without payloads
//! never reads `agent_payloads`.
//!
//! Which fields are payloads, and their previews, are the client view's
//! (`client_view::whole` and `trim`): a field over `client_view::TRIM_ABOVE`
//! whose preview leaves out at least half of it, in an Item that is not
//! conversation text. Smaller fields are sent to clients whole, so moving
//! them out would make every detail request read them back.
//!
//! Rows that do not fit together (missing, extra, out of order, unreadable)
//! are `Damaged`: an error for that Agent only. The record each Agent had
//! before its conversion is kept in `agent_originals` for ORIGINALS_KEPT, so
//! Core can still show a damaged Agent (see `store`), and `revert` can store
//! it whole again for an older Core.
//!
//! Turns or Items without a usable ID (missing, not a string, repeated, or
//! starting with `~`) are keyed by position instead (`~3`), so any record
//! round-trips exactly; real records have none.
//!
//! `assemble(split(d), true)` gives back exactly `d`. serde_json's
//! `preserve_order` is off here (members are sorted maps), and the rows keep
//! each member where it was anyway: `null` and the Item count stand in the
//! place of what they replace, and the annotation is the last member.
pub mod window;

use crate::model::AgentDetail;
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Item annotation naming each field stored as a payload: the client
/// view's, with its full size, which end the preview keeps, and its lines.
pub const TRUNCATED: &str = crate::client_view::TRUNCATED;
/// How long the record each Agent had before its conversion is kept.
pub const ORIGINALS_KEPT: chrono::Duration = chrono::Duration::days(30);
/// Prefix of keys given by position. IDs starting with it are keyed by
/// position too, so a positional key never equals an ID used as a key.
const POSITIONAL: char = '~';
// The SQL above selects positional keys as `>='~' AND <char(127)`.
const _: () = assert!(POSITIONAL as u32 == 0x7e);
/// `workspace_meta` key: the backup taken before the first conversion.
const BACKUP_KEY: &str = "recordRowsBackup";
/// `workspace_meta` key: a backup being written. Recorded before the copy
/// starts, so a copy a crash interrupted is found (and removed) next time.
const PENDING_KEY: &str = "recordRowsBackupPending";
/// `workspace_meta` key: records were stored whole again (`revert`), so the
/// next conversion takes a new backup.
const NEEDED_KEY: &str = "recordRowsBackupNeeded";
/// `workspace_meta` key: backups taken before the latest, as a JSON array.
/// No backup path is ever forgotten.
const EARLIER_KEY: &str = "recordRowsEarlierBackups";
/// Item and Turn annotation: what `revert` could not give back of a damaged
/// record.
pub const SALVAGE: &str = "_yuzunoSalvage";

/// An Agent's stored record cannot be assembled: its rows are missing,
/// extra, out of order or unreadable (or its whole row is). It concerns that
/// Agent only.
#[derive(Debug)]
pub struct Damaged {
    pub agent: String,
    pub cause: String,
}

impl std::fmt::Display for Damaged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Agent {} 的记录无法读取：{}", self.agent, self.cause)
    }
}

impl std::error::Error for Damaged {}

fn damaged(agent: &str, error: anyhow::Error) -> anyhow::Error {
    Damaged { agent: agent.into(), cause: format!("{error:#}") }.into()
}

/// How an Agent's record is stored in `agents`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Layout {
    /// `data` is the whole record (every build before this one).
    #[default]
    Whole,
    /// `data` is the metadata; Turns, Items and payloads are rows.
    Rows,
}

impl Layout {
    fn from_column(value: i64) -> Result<Self> {
        match value {
            0 => Ok(Layout::Whole),
            1 => Ok(Layout::Rows),
            other => bail!("Agent record layout {other} is unknown to this Core"),
        }
    }
}

/// Runs on every open: creates the tables and the `layout` column. It never
/// converts a record (see `convert`). Older builds ignore all of it.
pub fn migrate(db: &Connection) -> Result<()> {
    let has_layout: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('agents') WHERE name='layout')", [], |r| r.get(0))?;
    if !has_layout {
        db.execute_batch("ALTER TABLE agents ADD COLUMN layout INTEGER NOT NULL DEFAULT 0")?;
    }
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_turns(
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL, ord INTEGER NOT NULL,
            -- Its Item rows; NULL when data is the whole Turn (no Item array).
            items INTEGER,
            data TEXT NOT NULL,
            PRIMARY KEY(agent_id, turn_id));
        CREATE TABLE IF NOT EXISTS agent_items(
            agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
            ord INTEGER NOT NULL,
            -- Its payload rows: data holds null in their place, and previews
            -- (NULL without payloads) an object of their previews by field.
            payloads INTEGER NOT NULL DEFAULT 0,
            data TEXT NOT NULL,
            previews TEXT,
            PRIMARY KEY(agent_id, turn_id, item_id),
            FOREIGN KEY(agent_id, turn_id) REFERENCES agent_turns(agent_id, turn_id) ON DELETE CASCADE);
        -- An Item by its ID in any Turn (payload requests without a Turn).
        CREATE INDEX IF NOT EXISTS agent_items_by_id ON agent_items(agent_id, item_id);
        CREATE TABLE IF NOT EXISTS agent_payloads(
            agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, field TEXT NOT NULL,
            data TEXT NOT NULL,
            PRIMARY KEY(agent_id, turn_id, item_id, field),
            FOREIGN KEY(agent_id, turn_id, item_id) REFERENCES agent_items(agent_id, turn_id, item_id) ON DELETE CASCADE);
        -- Every row of a damaged record, as it was when revert stored the
        -- record whole again (kind: metadata, original, turn, item, payload).
        CREATE TABLE IF NOT EXISTS agent_salvage(
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            saved_at TEXT NOT NULL, kind TEXT NOT NULL, turn_id TEXT, item_id TEXT, field TEXT,
            ord INTEGER, count INTEGER, data TEXT, previews TEXT);
        -- The whole row each Agent had when it was converted, for a while.
        CREATE TABLE IF NOT EXISTS agent_originals(
            agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
            data TEXT NOT NULL, converted_at TEXT NOT NULL);
        -- Every Core enables foreign keys; only a manual edit without them
        -- can leave rows behind.
        DELETE FROM agent_originals WHERE agent_id NOT IN (SELECT id FROM agents);
        DELETE FROM agent_turns WHERE agent_id NOT IN (SELECT id FROM agents);
        DELETE FROM agent_items WHERE NOT EXISTS (SELECT 1 FROM agent_turns t
            WHERE t.agent_id=agent_items.agent_id AND t.turn_id=agent_items.turn_id);
        DELETE FROM agent_payloads WHERE NOT EXISTS (SELECT 1 FROM agent_items i
            WHERE i.agent_id=agent_payloads.agent_id AND i.turn_id=agent_payloads.turn_id AND i.item_id=agent_payloads.item_id);",
    )?;
    window::migrate(db)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Rows in memory

/// One Agent's rows, as `split` produces them and the database holds them.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rows {
    /// `agents.data`: the record without `turns`.
    pub meta: String,
    pub turns: Vec<TurnRow>,
    pub items: Vec<ItemRow>,
    /// Empty when read without payloads.
    pub payloads: Vec<PayloadRow>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TurnRow {
    pub key: String,
    pub ord: usize,
    /// Its Item rows; None when `data` is the whole Turn.
    pub items: Option<usize>,
    pub data: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ItemRow {
    pub turn: String,
    pub key: String,
    pub ord: usize,
    /// Its payload rows.
    pub payloads: usize,
    pub data: String,
    /// Previews of its payloads by field; None without payloads, or when
    /// read with payloads (which replace them).
    pub previews: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PayloadRow {
    pub turn: String,
    pub item: String,
    pub field: String,
    pub data: String,
}

/// Row keys for a list of IDs: the ID itself when it is a string, unique in
/// the list and not starting with `~`; otherwise `~` and the position.
fn keys<'a>(ids: impl Iterator<Item = Option<&'a str>>) -> Vec<String> {
    let ids: Vec<Option<&str>> = ids.collect();
    let mut seen: HashMap<&str, usize> = HashMap::new();
    for id in ids.iter().flatten() {
        *seen.entry(*id).or_default() += 1;
    }
    ids.iter().enumerate().map(|(ord, id)| match id {
        Some(id) if seen[id] == 1 && !id.starts_with(POSITIONAL) => (*id).to_owned(),
        _ => format!("{POSITIONAL}{ord}"),
    }).collect()
}

fn positional(key: &str) -> bool {
    key.starts_with(POSITIONAL)
}

fn turn_keys(turns: &[Value]) -> Vec<String> {
    keys(turns.iter().map(|t| t["id"].as_str()))
}

fn item_keys(items: &[Value]) -> Vec<String> {
    keys(items.iter().map(|i| i["id"].as_str()))
}

/// A Turn's Items when they get rows of their own: it is an object with an
/// Item array. Otherwise its row holds the whole Turn.
fn split_items(turn: &Value) -> Option<&Vec<Value>> {
    turn.as_object()?.get("items")?.as_array()
}

/// An object serialized with some members' values replaced in place and
/// optionally one member added at the end, without copying the rest.
struct Members<'a> {
    members: &'a Map<String, Value>,
    replaced: &'a [(&'a str, Value)],
    added: Option<(&'static str, &'a Value)>,
}

impl Serialize for Members<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.members.len() + usize::from(self.added.is_some())))?;
        for (key, value) in self.members {
            match self.replaced.iter().find(|(name, _)| *name == key) {
                Some((_, replacement)) => map.serialize_entry(key, replacement)?,
                None => map.serialize_entry(key, value)?,
            }
        }
        if let Some((key, value)) = self.added {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

/// A Turn's row: the Turn with its Item count in place of its Items, and
/// that count; or the whole Turn and None.
fn turn_row(turn: &Value) -> Result<(String, Option<usize>)> {
    match (turn.as_object(), split_items(turn)) {
        (Some(members), Some(items)) => {
            let replaced = [("items", Value::from(items.len()))];
            Ok((serde_json::to_string(&Members { members, replaced: &replaced, added: None })?, Some(items.len())))
        }
        _ => Ok((serde_json::to_string(turn)?, None)),
    }
}

/// An Item's row: its data, its previews, and its payloads (field, full
/// value as JSON).
struct ItemOut {
    data: String,
    previews: Option<String>,
    payloads: Vec<(String, String)>,
}

fn item_row(item: &Value) -> Result<ItemOut> {
    let whole_row = |item| Ok(ItemOut { data: serde_json::to_string(item)?, previews: None, payloads: Vec::new() });
    // An Item that already carries the annotation is kept whole, so the
    // annotation in a row always means payloads.
    let Some(members) = item.as_object().filter(|m| !m.contains_key(TRUNCATED) && !crate::client_view::whole(item)) else {
        return whole_row(item);
    };
    let mut replaced = Vec::new();
    let mut notes = Map::new();
    let mut previews = Map::new();
    let mut payloads = Vec::new();
    for (key, value) in members {
        if let Some((preview, note)) = crate::client_view::trim(item, key, value) {
            payloads.push((key.clone(), serde_json::to_string(value)?));
            notes.insert(key.clone(), note);
            previews.insert(key.clone(), preview);
            replaced.push((key.as_str(), Value::Null));
        }
    }
    if payloads.is_empty() {
        return whole_row(item);
    }
    let notes = Value::Object(notes);
    let data = serde_json::to_string(&Members { members, replaced: &replaced, added: Some((TRUNCATED, &notes)) })?;
    Ok(ItemOut { data, previews: Some(serde_json::to_string(&previews)?), payloads })
}

/// A record's members after `agent`, serialized straight from it (nothing
/// is copied first) exactly as `AgentDetail` serializes them; with or
/// without `turns`. `record_tail_is_the_record_without_its_agent` checks
/// this against serde's own output.
struct AfterAgent<'a> {
    detail: &'a AgentDetail,
    turns: bool,
}

impl Serialize for AfterAgent<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        // Listed in full, so a new field of AgentDetail cannot be left out
        // silently: it does not compile until it is added here.
        let AgentDetail { agent: _, turns, history, pending, artifacts, context_usage, message_receipts,
            claude_runtime, codex_handoff } = self.detail;
        let mut map = serializer.serialize_map(None)?;
        if self.turns {
            map.serialize_entry("turns", turns)?;
        }
        if history.is_some() {
            map.serialize_entry("history", history)?;
        }
        map.serialize_entry("pending", pending)?;
        map.serialize_entry("artifacts", artifacts)?;
        map.serialize_entry("contextUsage", context_usage)?;
        map.serialize_entry("messageReceipts", message_receipts)?;
        if claude_runtime.is_some() {
            map.serialize_entry("claudeRuntime", claude_runtime)?;
        }
        if codex_handoff.is_some() {
            map.serialize_entry("codexHandoff", codex_handoff)?;
        }
        map.end()
    }
}

/// The whole record after its `agent`, closing brace included: what
/// follows `{"agent":<agent>` in its whole row.
fn whole_tail(detail: &AgentDetail) -> Result<String> {
    let mut rest = serde_json::to_string(&AfterAgent { detail, turns: true })?;
    ensure!(rest.starts_with('{') && rest.len() > 2, "Agent record serialized without members");
    rest.replace_range(..1, ",");
    Ok(rest)
}

/// `agents.data` for the rows layout (the record without `turns`), apart
/// from its `agent`: serialized before the writer is taken. `row` adds the
/// agent, whose journal position and unread count the writer decides.
pub struct MetaBody(String);

impl MetaBody {
    pub fn of(detail: &AgentDetail) -> Result<Self> {
        let mut rest = serde_json::to_string(&AfterAgent { detail, turns: false })?;
        // `{...}` without its braces, after a comma.
        rest.pop();
        if rest.len() > 1 {
            rest.replace_range(..1, ",");
        } else {
            rest.clear();
        }
        Ok(MetaBody(rest))
    }

    pub fn row(&self, agent: &crate::model::Agent) -> Result<String> {
        Ok(format!("{{\"agent\":{}{}}}", serde_json::to_string(agent)?, self.0))
    }
}

/// `agents.data` for the rows layout: the record without `turns`.
fn meta(detail: &AgentDetail) -> Result<String> {
    MetaBody::of(detail)?.row(&detail.agent)
}

/// The record a metadata row describes, with no Turns yet.
fn from_meta(text: &str) -> Result<AgentDetail> {
    let mut value: Value = serde_json::from_str(text).context("Workspace 记录无法读取")?;
    let members = value.as_object_mut().context("Agent metadata is not an object")?;
    ensure!(!members.contains_key("turns"), "Agent metadata row carries Turns");
    members.insert("turns".into(), Value::Array(Vec::new()));
    serde_json::from_value(value).context("Workspace 记录无法读取")
}

/// The rows of a record.
pub fn split(detail: &AgentDetail) -> Result<Rows> {
    let mut rows = Rows { meta: meta(detail)?, ..Rows::default() };
    for (ord, (turn, key)) in detail.turns.iter().zip(turn_keys(&detail.turns)).enumerate() {
        let (data, items) = turn_row(turn)?;
        if let Some(list) = split_items(turn) {
            for (item_ord, (item, item_key)) in list.iter().zip(item_keys(list)).enumerate() {
                let ItemOut { data, previews, payloads } = item_row(item)?;
                let count = payloads.len();
                for (field, data) in payloads {
                    rows.payloads.push(PayloadRow { turn: key.clone(), item: item_key.clone(), field, data });
                }
                rows.items.push(ItemRow { turn: key.clone(), key: item_key, ord: item_ord, payloads: count, data, previews });
            }
        }
        rows.turns.push(TurnRow { key, ord, items, data });
    }
    Ok(rows)
}

/// The record its rows describe. Without payloads, each large field is its
/// preview and the Item notes it under `_yuzunoTruncated`, as the client
/// view sends it (previews must have been read); with them, it is exactly
/// the record that was split.
/// Rows that do not fit together (missing, extra or out of order) are an
/// error rather than a record silently missing part of its history.
pub fn assemble(rows: Rows, payloads: bool) -> Result<AgentDetail> {
    let mut detail = from_meta(&rows.meta)?;
    let id = detail.agent.id.clone();
    let mut items: HashMap<String, Vec<ItemRow>> = HashMap::new();
    for item in rows.items {
        items.entry(item.turn.clone()).or_default().push(item);
    }
    // Without payloads, payload rows (if any were read) are left alone.
    let mut fields: HashMap<(String, String), Vec<PayloadRow>> = HashMap::new();
    for payload in rows.payloads.into_iter().filter(|_| payloads) {
        fields.entry((payload.turn.clone(), payload.item.clone())).or_default().push(payload);
    }
    let mut turns = rows.turns;
    turns.sort_by_key(|t| t.ord);
    for (ord, row) in turns.into_iter().enumerate() {
        ensure!(row.ord == ord, "Agent {id}: Turn rows are not in order");
        let list = items.remove(&row.key).unwrap_or_default();
        detail.turns.push(assemble_turn(&id, row, list, &mut fields, payloads)?);
    }
    ensure!(items.is_empty(), "Agent {id}: Item rows without a Turn row");
    ensure!(fields.is_empty(), "Agent {id}: payload rows without an Item row");
    Ok(detail)
}

/// One Turn from its row, its Item rows and (taken from `fields`) payloads.
fn assemble_turn(agent: &str, row: TurnRow, mut items: Vec<ItemRow>,
    fields: &mut HashMap<(String, String), Vec<PayloadRow>>, payloads: bool) -> Result<Value> {
    let mut turn: Value = serde_json::from_str(&row.data).context("Workspace 记录无法读取")?;
    let Some(count) = row.items else {
        ensure!(items.is_empty(), "Agent {agent}: Item rows for Turn {} stored whole", row.key);
        return Ok(turn);
    };
    items.sort_by_key(|i| i.ord);
    ensure!(items.len() == count && items.iter().enumerate().all(|(n, i)| i.ord == n),
        "Agent {agent}: Turn {} has {} of its {count} Item rows", row.key, items.len());
    let mut list = Vec::with_capacity(count);
    for item in items {
        let mut value: Value = serde_json::from_str(&item.data).context("Workspace 记录无法读取")?;
        if item.payloads > 0 {
            let filled = if payloads {
                let found = fields.remove(&(row.key.clone(), item.key.clone())).unwrap_or_default();
                fill(&mut value, found.into_iter().map(|p| (p.field, p.data)).collect(), item.payloads)
            } else {
                preview_fields(&mut value, item.previews.as_deref(), item.payloads)
            };
            filled.with_context(|| format!("Agent {agent}: Item {} of Turn {}", item.key, row.key))?;
        }
        list.push(value);
    }
    let members = turn.as_object_mut().context("Turn row is not an object")?;
    ensure!(members.get("items") == Some(&Value::from(count)), "Agent {agent}: Turn {} row has another Item count", row.key);
    members.insert("items".into(), Value::Array(list));
    Ok(turn)
}

/// Puts an Item's payloads in their places and drops the annotation.
fn fill(item: &mut Value, payloads: Vec<(String, String)>, expected: usize) -> Result<()> {
    ensure!(payloads.len() == expected, "{} of its {expected} payload rows", payloads.len());
    let members = item.as_object_mut().context("Item with payloads is not an object")?;
    let Some(Value::Object(mut notes)) = members.remove(TRUNCATED) else {
        bail!("Item with payloads does not note them");
    };
    for (field, data) in payloads {
        ensure!(notes.remove(&field).is_some(), "payload {field} is not noted");
        let value = serde_json::from_str(&data).context("Workspace 记录无法读取")?;
        ensure!(members.insert(field.clone(), value) == Some(Value::Null), "payload {field} has no place");
    }
    ensure!(notes.is_empty(), "noted payloads are missing");
    Ok(())
}

/// Puts an Item's previews in the places of its payloads, keeping the
/// annotation, as the client view does.
fn preview_fields(item: &mut Value, previews: Option<&str>, expected: usize) -> Result<()> {
    let previews: Map<String, Value> = serde_json::from_str(previews.context("Item previews were not read")?)
        .context("Workspace 记录无法读取")?;
    ensure!(previews.len() == expected, "{} of its {expected} previews", previews.len());
    let members = item.as_object_mut().context("Item with payloads is not an object")?;
    ensure!(members.get(TRUNCATED).is_some_and(Value::is_object), "Item with payloads does not note them");
    for (field, preview) in previews {
        ensure!(members.insert(field.clone(), preview) == Some(Value::Null), "preview {field} has no place");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Reading

/// What `agents` holds for one Agent.
#[derive(Debug)]
pub enum Stored {
    /// The whole record, as JSON (layout 0).
    Whole(String),
    Rows(Rows),
}

/// Reads inside one read transaction when the caller has none, so several
/// statements see one state of the database.
fn snapshot(db: &Connection) -> Result<Option<rusqlite::Transaction<'_>>> {
    Ok(if db.is_autocommit() { Some(db.unchecked_transaction()?) } else { None })
}

/// A stored position or count. A negative one cannot be right: it becomes
/// one no check accepts, so the record is `Damaged` rather than the read
/// failing like a database error.
fn count(value: i64) -> rusqlite::Result<usize> {
    Ok(usize::try_from(value).unwrap_or(usize::MAX))
}

/// An Agent's stored record. Without payloads, `agent_payloads` is not read.
pub fn read(db: &Connection, id: &str, payloads: bool) -> Result<Option<Stored>> {
    let _snapshot = snapshot(db)?;
    let Some((meta, layout)) = db.prepare_cached("SELECT data, layout FROM agents WHERE id=?1")?
        .query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).optional()? else {
        return Ok(None);
    };
    if Layout::from_column(layout)? == Layout::Whole {
        return Ok(Some(Stored::Whole(meta)));
    }
    let turns = db.prepare_cached("SELECT turn_id, ord, items, data FROM agent_turns WHERE agent_id=?1")?
        .query_map([id], |r| Ok(TurnRow { key: r.get(0)?, ord: count(r.get(1)?)?,
            items: r.get::<_, Option<i64>>(2)?.map(count).transpose()?, data: r.get(3)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let items = db.prepare_cached(if payloads {
        "SELECT turn_id, item_id, ord, payloads, data, NULL FROM agent_items WHERE agent_id=?1"
    } else {
        "SELECT turn_id, item_id, ord, payloads, data, previews FROM agent_items WHERE agent_id=?1"
    })?.query_map([id], item_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let payloads = if payloads {
        db.prepare_cached("SELECT turn_id, item_id, field, data FROM agent_payloads WHERE agent_id=?1")?
            .query_map([id], payload_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        Vec::new()
    };
    Ok(Some(Stored::Rows(Rows { meta, turns, items, payloads })))
}

fn item_from_row(r: &rusqlite::Row) -> rusqlite::Result<ItemRow> {
    Ok(ItemRow { turn: r.get(0)?, key: r.get(1)?, ord: count(r.get(2)?)?, payloads: count(r.get(3)?)?, data: r.get(4)?,
        previews: r.get(5)? })
}

fn payload_from_row(r: &rusqlite::Row) -> rusqlite::Result<PayloadRow> {
    Ok(PayloadRow { turn: r.get(0)?, item: r.get(1)?, field: r.get(2)?, data: r.get(3)? })
}

/// An Agent's record, in either layout. Without payloads, large fields are
/// previews (see `assemble`); a record still stored whole is always full.
/// A record that cannot be assembled is `Damaged`; database errors are not.
pub fn load(db: &Connection, id: &str, payloads: bool) -> Result<Option<AgentDetail>> {
    Ok(match read(db, id, payloads)? {
        None => None,
        Some(stored) => Some(assemble_stored(id, stored, payloads)?),
    })
}

/// The record a `read` gave; `Damaged` if it does not assemble.
pub fn assemble_stored(id: &str, stored: Stored, payloads: bool) -> Result<AgentDetail> {
    match stored {
        Stored::Whole(text) => serde_json::from_str(&text).map_err(|e| damaged(id, e.into())),
        Stored::Rows(rows) => assemble(rows, payloads).map_err(|e| damaged(id, e)),
    }
}

/// Whether an Agent's rows fit together as far as SQL tells without parsing
/// them: Turn and Item positions, Item counts, payload counts, and no row
/// without its Turn or Item. A few index scans, no JSON; rows whose data does
/// not parse are found only by assembling them. True for a record stored
/// whole.
pub fn rows_fit(db: &Connection, id: &str) -> Result<bool> {
    let _snapshot = snapshot(db)?;
    let checks = [
        // Turn positions are 0..n.
        "SELECT COUNT(*) > 0 AND (MIN(ord) != 0 OR MAX(ord) != COUNT(*) - 1 OR COUNT(DISTINCT ord) != COUNT(*))
            FROM agent_turns WHERE agent_id=?1",
        // Each Turn has the Item rows it counts (none if stored whole).
        "SELECT COUNT(*) FROM agent_turns t WHERE t.agent_id=?1 AND COALESCE(t.items, 0) !=
            (SELECT COUNT(*) FROM agent_items i WHERE i.agent_id=t.agent_id AND i.turn_id=t.turn_id)",
        // Item positions are 0..n in each Turn.
        "SELECT COUNT(*) FROM (SELECT MIN(ord) AS low, MAX(ord) AS high, COUNT(*) AS n, COUNT(DISTINCT ord) AS distinct_ord
            FROM agent_items WHERE agent_id=?1 GROUP BY turn_id) WHERE low != 0 OR high != n - 1 OR distinct_ord != n",
        // No Item row without its Turn row.
        "SELECT COUNT(*) FROM agent_items i WHERE i.agent_id=?1 AND NOT EXISTS
            (SELECT 1 FROM agent_turns t WHERE t.agent_id=i.agent_id AND t.turn_id=i.turn_id)",
        // Each Item has the payload rows it counts, and no payload row is
        // without its Item.
        "SELECT COUNT(*) FROM agent_items i WHERE i.agent_id=?1 AND i.payloads !=
            (SELECT COUNT(*) FROM agent_payloads p WHERE p.agent_id=i.agent_id AND p.turn_id=i.turn_id AND p.item_id=i.item_id)",
        "SELECT COUNT(*) FROM agent_payloads p WHERE p.agent_id=?1 AND NOT EXISTS
            (SELECT 1 FROM agent_items i WHERE i.agent_id=p.agent_id AND i.turn_id=p.turn_id AND i.item_id=p.item_id)",
    ];
    for sql in checks {
        if db.prepare_cached(sql)?.query_row([id], |r| r.get::<_, i64>(0))? != 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

/// The Agent's layout, or None if there is no such Agent.
pub fn layout(db: &Connection, id: &str) -> Result<Option<Layout>> {
    db.prepare_cached("SELECT layout FROM agents WHERE id=?1")?
        .query_row([id], |r| r.get::<_, i64>(0)).optional()?
        .map(Layout::from_column).transpose()
}

/// The record without its Turns.
pub fn load_meta(db: &Connection, id: &str) -> Result<Option<AgentDetail>> {
    let _snapshot = snapshot(db)?;
    let Some((data, layout)) = db.prepare_cached("SELECT data, layout FROM agents WHERE id=?1")?
        .query_row([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))).optional()? else {
        return Ok(None);
    };
    Ok(Some(match Layout::from_column(layout)? {
        Layout::Rows => from_meta(&data).map_err(|e| damaged(id, e))?,
        Layout::Whole => {
            let mut detail: AgentDetail = serde_json::from_str(&data).map_err(|e| damaged(id, e.into()))?;
            detail.turns.clear();
            detail
        }
    }))
}

/// What an Agent's listed view needs (`rail::project` reads only the newest
/// Turn, `store` the status of each): its metadata, every Turn's own fields
/// (holding no Items) and the newest Turn with its Items, without payloads.
/// No other Item row is read. A record stored whole is read in full.
/// `Damaged` if it does not assemble.
pub fn load_recent(db: &Connection, id: &str) -> Result<Option<AgentDetail>> {
    let _snapshot = snapshot(db)?;
    match layout(db, id)? {
        None => return Ok(None),
        Some(Layout::Whole) => return load(db, id, false),
        Some(Layout::Rows) => {}
    }
    let Some(mut detail) = load_meta(db, id)? else { return Ok(None) };
    let turns = db.prepare_cached("SELECT turn_id, ord, items, data FROM agent_turns WHERE agent_id=?1 ORDER BY ord")?
        .query_map([id], |r| Ok(TurnRow { key: r.get(0)?, ord: count(r.get(1)?)?,
            items: r.get::<_, Option<i64>>(2)?.map(count).transpose()?, data: r.get(3)? }))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let newest = turns.len().checked_sub(1);
    for (ord, row) in turns.into_iter().enumerate() {
        if row.ord != ord {
            return Err(damaged(id, anyhow::anyhow!("Turn rows are not in order")));
        }
        let turn = if Some(ord) == newest {
            let items = db.prepare_cached("SELECT turn_id, item_id, ord, payloads, data, previews FROM agent_items WHERE agent_id=?1 AND turn_id=?2")?
                .query_map(params![id, row.key], item_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
            assemble_turn(id, row, items, &mut HashMap::new(), false).map_err(|e| damaged(id, e))?
        } else {
            let whole = row.items.is_none();
            let mut turn: Value = serde_json::from_str(&row.data).map_err(|e| damaged(id, e.into()))?;
            if let (false, Some(members)) = (whole, turn.as_object_mut()) {
                members.insert("items".into(), Value::Array(Vec::new()));
            }
            turn
        };
        detail.turns.push(turn);
    }
    Ok(Some(detail))
}

/// What `Store::open` reads to mark an Agent restarted without its record
/// (T-140): every Turn that has user messages, with its ID and those Items
/// alone, in order and without payloads (all `message_content::bind` reads),
/// and whether the newest Turn is in progress. SQLite picks the user
/// messages; no other Item is parsed. For a record stored as rows; `Damaged`
/// if a row read does not parse.
pub fn restart_view(db: &Connection, id: &str) -> Result<(Vec<Value>, bool)> {
    let _snapshot = snapshot(db)?;
    let newest = db.prepare_cached("SELECT data FROM agent_turns WHERE agent_id=?1 ORDER BY ord DESC LIMIT 1")?
        .query_row([id], |r| r.get::<_, String>(0)).optional()?;
    let in_progress = match newest {
        Some(data) => serde_json::from_str::<Value>(&data).map_err(|e| damaged(id, e.into()))?["status"] == "inProgress",
        None => false,
    };
    let rows = db.prepare_cached(
        "SELECT t.turn_id, t.data, i.data FROM agent_items i
         JOIN agent_turns t ON t.agent_id=i.agent_id AND t.turn_id=i.turn_id
         WHERE i.agent_id=?1 AND json_extract(i.data,'$.type')='userMessage' ORDER BY t.ord, i.ord")?
        .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut turns: Vec<Value> = Vec::new();
    let mut current: Option<String> = None;
    for (key, turn, item) in rows {
        let item: Value = serde_json::from_str(&item).map_err(|e| damaged(id, e.into()))?;
        if current.as_deref() != Some(key.as_str()) {
            let turn: Value = serde_json::from_str(&turn).map_err(|e| damaged(id, e.into()))?;
            turns.push(json!({"id": turn["id"], "items": []}));
            current = Some(key);
        }
        if let Some(items) = turns.last_mut().and_then(|t| t["items"].as_array_mut()) {
            items.push(item);
        }
    }
    Ok((turns, in_progress))
}

/// Where a Turn's rows are: its key, or None if the Agent has no such Turn.
/// With repeated IDs the newest such Turn is meant, as the client view does.
fn turn_key(db: &Connection, agent: &str, turn_id: &str) -> Result<Option<String>> {
    if !positional(turn_id) {
        let found = db.prepare_cached("SELECT turn_id FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?
            .query_row(params![agent, turn_id], |r| r.get::<_, String>(0)).optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    // Rows keyed by position name their Turn only inside their data.
    let mut query = db.prepare_cached(
        "SELECT turn_id, data FROM agent_turns WHERE agent_id=?1 AND turn_id>='~' AND turn_id<char(127) ORDER BY ord DESC")?;
    let rows = query.query_map([agent], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (key, data) = row?;
        let turn: Value = serde_json::from_str(&data).map_err(|e| damaged(agent, e.into()))?;
        if turn["id"] == turn_id {
            return Ok(Some(key));
        }
    }
    Ok(None)
}

/// One Turn of an Agent, with or without its payloads; None if the Agent
/// has no such Turn.
pub fn load_turn(db: &Connection, agent: &str, turn_id: &str, payloads: bool) -> Result<Option<Value>> {
    let _snapshot = snapshot(db)?;
    match layout(db, agent)? {
        None => return Ok(None),
        Some(Layout::Whole) => {
            let detail = load(db, agent, true)?.context("Agent 不存在")?;
            return Ok(detail.turns.into_iter().rev().find(|t| t["id"] == turn_id));
        }
        Some(Layout::Rows) => {}
    }
    let Some(key) = turn_key(db, agent, turn_id)? else { return Ok(None) };
    let row = db.prepare_cached("SELECT turn_id, ord, items, data FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?
        .query_row(params![agent, key], |r| Ok(TurnRow { key: r.get(0)?, ord: count(r.get(1)?)?,
            items: r.get::<_, Option<i64>>(2)?.map(count).transpose()?, data: r.get(3)? }))?;
    let items = db.prepare_cached(if payloads {
        "SELECT turn_id, item_id, ord, payloads, data, NULL FROM agent_items WHERE agent_id=?1 AND turn_id=?2"
    } else {
        "SELECT turn_id, item_id, ord, payloads, data, previews FROM agent_items WHERE agent_id=?1 AND turn_id=?2"
    })?.query_map(params![agent, key], item_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut fields: HashMap<(String, String), Vec<PayloadRow>> = HashMap::new();
    if payloads {
        let rows = db.prepare_cached("SELECT turn_id, item_id, field, data FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2")?
            .query_map(params![agent, key], payload_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        for payload in rows {
            fields.entry((payload.turn.clone(), payload.item.clone())).or_default().push(payload);
        }
    }
    let turn = assemble_turn(agent, row, items, &mut fields, payloads).map_err(|e| damaged(agent, e))?;
    if !fields.is_empty() {
        return Err(damaged(agent, anyhow::anyhow!("payload rows without an Item row")));
    }
    Ok(Some(turn))
}

/// One Item of an Agent, in a Turn holding only it (with the Turn's own
/// fields), with or without its payloads. Without a Turn ID the newest Item
/// with this ID is meant, as the client view does. A Turn named that does
/// not have the Item comes back holding no Items. None if there is no such
/// Turn, or no such Item in any Turn.
pub fn load_item(db: &Connection, agent: &str, turn_id: Option<&str>, item_id: &str, payloads: bool) -> Result<Option<Value>> {
    let _snapshot = snapshot(db)?;
    let alone = |mut turn: Value, item: Value| {
        if let Some(members) = turn.as_object_mut() {
            members.insert("items".into(), Value::Array(vec![item]));
        }
        turn
    };
    match layout(db, agent)? {
        None => return Ok(None),
        Some(Layout::Whole) => {
            let detail = load(db, agent, true)?.context("Agent 不存在")?;
            let mut turns = detail.turns.iter().rev().filter(|t| turn_id.is_none_or(|id| t["id"] == id)).peekable();
            let named = turn_id.and_then(|_| turns.peek().map(|turn| (*turn).clone()));
            let found = turns.find_map(|t| t["items"].as_array()?.iter().rev().find(|i| i["id"] == item_id).map(|i| (t, i)));
            return Ok(match (found, named) {
                (Some((turn, item)), _) => Some(alone(turn.clone(), item.clone())),
                (None, Some(turn)) => Some(alone(turn, Value::Null)).map(|mut turn| { turn["items"] = Value::Array(Vec::new()); turn }),
                (None, None) => None,
            });
        }
        Some(Layout::Rows) => {}
    }
    let Some(turn_id) = turn_id else {
        return match newest_item(db, agent, item_id)? {
            Some((turn, item)) => {
                let (turn, row) = load_one(db, agent, &turn, &item, payloads)?;
                Ok(Some(alone(turn, row)))
            }
            None => Ok(None),
        };
    };
    let turns: Vec<String> = turn_key(db, agent, turn_id)?.into_iter().collect();
    for key in &turns {
        let Some(item) = item_key(db, agent, key, item_id)? else { continue };
        let (turn, row) = load_one(db, agent, key, &item, payloads)?;
        return Ok(Some(alone(turn, row)));
    }
    match turns.first() {
        Some(key) => {
            let data: String = db.prepare_cached("SELECT data FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?
                .query_row(params![agent, key], |r| r.get(0))?;
            let mut turn: Value = serde_json::from_str(&data).map_err(|e| damaged(agent, e.into()))?;
            if let Some(members) = turn.as_object_mut() {
                members.insert("items".into(), Value::Array(Vec::new()));
            }
            Ok(Some(turn))
        }
        None => Ok(None),
    }
}

/// Item rows by ID in any Turn, newest Turn first: `agent_items_by_id`.
const NEWEST_ITEM: &str = "SELECT i.turn_id, i.item_id, t.ord FROM agent_items i INDEXED BY agent_items_by_id
    JOIN agent_turns t ON t.agent_id=i.agent_id AND t.turn_id=i.turn_id
    WHERE i.agent_id=?1 AND i.item_id=?2 ORDER BY t.ord DESC LIMIT 1";
/// Item rows keyed by position (a range of `agent_items_by_id`) in Turns
/// after a position, newest first.
const POSITIONAL_ITEMS: &str = "SELECT i.turn_id, i.item_id, i.data FROM agent_items i INDEXED BY agent_items_by_id
    JOIN agent_turns t ON t.agent_id=i.agent_id AND t.turn_id=i.turn_id
    WHERE i.agent_id=?1 AND i.item_id>='~' AND i.item_id<char(127) AND t.ord>?2 ORDER BY t.ord DESC, i.ord DESC";

/// Where the newest Item with this ID is (Turn and Item keys), in any Turn:
/// one indexed query, and one more over rows keyed by position (which hold
/// their ID only in their data) in newer Turns.
fn newest_item(db: &Connection, agent: &str, item_id: &str) -> Result<Option<(String, String)>> {
    let by_id: Option<(String, String, i64)> = if positional(item_id) {
        None
    } else {
        db.prepare_cached(NEWEST_ITEM)?
            .query_row(params![agent, item_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?
    };
    let after = by_id.as_ref().map_or(-1, |(_, _, ord)| *ord);
    let mut query = db.prepare_cached(POSITIONAL_ITEMS)?;
    let rows = query.query_map(params![agent, after], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?;
    for row in rows {
        let (turn, item, data) = row?;
        if serde_json::from_str::<Value>(&data).map_err(|e| damaged(agent, e.into()))?["id"] == item_id {
            return Ok(Some((turn, item)));
        }
    }
    Ok(by_id.map(|(turn, item, _)| (turn, item)))
}

/// The key of the newest Item with this ID in one Turn's rows.
fn item_key(db: &Connection, agent: &str, turn: &str, item_id: &str) -> Result<Option<String>> {
    if !positional(item_id) {
        let found = db.prepare_cached("SELECT item_id FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
            .query_row(params![agent, turn, item_id], |r| r.get::<_, String>(0)).optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    // Rows keyed by position name their Item only inside their data.
    let mut query = db.prepare_cached("SELECT item_id, data FROM agent_items
        WHERE agent_id=?1 AND turn_id=?2 AND item_id>='~' AND item_id<char(127) ORDER BY ord DESC")?;
    let rows = query.query_map(params![agent, turn], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (key, data) = row?;
        if serde_json::from_str::<Value>(&data).map_err(|e| damaged(agent, e.into()))?["id"] == item_id {
            return Ok(Some(key));
        }
    }
    Ok(None)
}

/// A Turn's own fields (without `items`) and one of its Items. Database
/// errors are returned as they are; only rows that do not fit together make
/// the record `Damaged`.
fn load_one(db: &Connection, agent: &str, turn: &str, item: &str, payloads: bool) -> Result<(Value, Value)> {
    let data: String = db.prepare_cached("SELECT data FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?
        .query_row(params![agent, turn], |r| r.get(0))?;
    let row = db.prepare_cached(if payloads {
        "SELECT turn_id, item_id, ord, payloads, data, NULL FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3"
    } else {
        "SELECT turn_id, item_id, ord, payloads, data, previews FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3"
    })?.query_row(params![agent, turn, item], item_from_row)?;
    let found = if payloads && row.payloads > 0 {
        db.prepare_cached("SELECT field, data FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
            .query_map(params![agent, turn, item], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?
    } else {
        Vec::new()
    };
    // Everything is read; the rest only assembles it.
    (|| -> Result<(Value, Value)> {
        let mut turn_value: Value = serde_json::from_str(&data)?;
        if let Some(members) = turn_value.as_object_mut() {
            members.remove("items");
        }
        let mut value: Value = serde_json::from_str(&row.data)?;
        if row.payloads > 0 {
            if payloads {
                fill(&mut value, found, row.payloads)?;
            } else {
                preview_fields(&mut value, row.previews.as_deref(), row.payloads)?;
            }
        }
        Ok((turn_value, value))
    })().map_err(|e| damaged(agent, e))
}

// ---------------------------------------------------------------------------
// Writing

/// What one Agent write changed. Rows rewritten with what they already held
/// are not counted (the database skips them).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Written {
    pub layout: Layout,
    /// Whether `agents.data` changed.
    pub meta: bool,
    pub turns: usize,
    pub items: usize,
    pub payloads: usize,
    /// Rows deleted directly (their Items and payloads go with them).
    pub deleted: usize,
}

/// What changed in a record since its rows were written: Turns and Items
/// by ID, or everything. The metadata is always written.
///
/// It only needs to name what changed in place. A write also compares the
/// Turns it is given with the Turn rows (IDs, order, Item counts), and the
/// Items of every Turn it writes with their rows, so added, removed and
/// moved Turns and Items are written even if not named.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Dirty {
    all: bool,
    /// Every Turn row (not their Items), e.g. after a compaction.
    turn_rows: bool,
    turns: HashMap<String, Touched>,
}

/// What changed in one Turn: its row always, and these Items or all of them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Touched {
    pub all_items: bool,
    pub items: HashSet<String>,
}

impl Dirty {
    /// Everything: snapshots, reconciliation, imports, and records whose
    /// changes are unknown.
    pub fn all() -> Self {
        Self { all: true, ..Self::default() }
    }

    pub fn is_all(&self) -> bool {
        self.all
    }

    /// Nothing beyond the metadata.
    pub fn is_meta_only(&self) -> bool {
        !self.all && !self.turn_rows && self.turns.is_empty()
    }

    /// The Turns named, and what changed in each.
    pub fn turns(&self) -> &HashMap<String, Touched> {
        &self.turns
    }

    pub fn all_turn_rows(&self) -> bool {
        self.turn_rows
    }

    /// The Turn's own fields.
    pub fn turn(&mut self, turn: &str) -> &mut Self {
        self.turns.entry(turn.into()).or_default();
        self
    }

    /// The Turn and all its Items.
    pub fn whole_turn(&mut self, turn: &str) -> &mut Self {
        self.turns.entry(turn.into()).or_default().all_items = true;
        self
    }

    /// One Item (and its Turn's own fields).
    pub fn item(&mut self, turn: &str, item: &str) -> &mut Self {
        self.turns.entry(turn.into()).or_default().items.insert(item.into());
        self
    }

    pub fn merge(&mut self, other: Dirty) {
        self.all |= other.all;
        self.turn_rows |= other.turn_rows;
        for (turn, touched) in other.turns {
            let mine = self.turns.entry(turn).or_default();
            mine.all_items |= touched.all_items;
            mine.items.extend(touched.items);
        }
    }

    /// What applying one native event changed (`AgentDetail::apply_at` for
    /// Codex kinds, `claude::project_event_at` for `claude/*`), from the
    /// event alone: what `Store::record_stream` and journal replay apply.
    ///
    /// - Codex Item events (`item/*`, deltas included) change their Item
    ///   and its Turn's own fields; `turn/started` and `turn/completed`
    ///   their Turn and the Items they carry; `turn/plan/updated` the Turn;
    ///   `thread/compacted` its Turn, or every Turn row without one.
    /// - Codex kinds `apply_at` ignores or that only change the metadata
    ///   (usage, requests, errors, status, hooks, rate limits, diffs,
    ///   automatic reviews) change no Turn.
    /// - Claude stream events, assistant and user messages and results
    ///   change their Turn (its Items are found from Turn scratch, so the
    ///   whole Turn is named); a compaction boundary every Turn row; other
    ///   Claude events only the metadata. Without a Turn, project_event_at
    ///   changes no Turn but on a compaction boundary. A sub-agent's events
    ///   change the Turn of the call that started it (see `of_applied`).
    /// - Any other kind changes its whole Turn if it names one; `apply_at`
    ///   changes no Turn for events naming none.
    pub fn of_event(kind: &str, data: &Value) -> Self {
        let mut dirty = Self::default();
        if kind.starts_with("claude/") {
            let event = &data["event"];
            match event["type"].as_str() {
                Some("system") => dirty.turn_rows = event["subtype"] == "compact_boundary",
                Some("rate_limit_event" | "tool_progress") => {}
                _ => {
                    if let Some(turn) = data["turnId"].as_str() {
                        dirty.whole_turn(turn);
                    }
                }
            }
            return dirty;
        }
        let turn = data["turnId"].as_str().or_else(|| data["turn"]["id"].as_str());
        let item = data["itemId"].as_str().or_else(|| data["item"]["id"].as_str());
        match kind {
            "thread/tokenUsage/updated" | "serverRequest/resolved" | "error" | "thread/status/changed"
            | "turn/diff/updated" | "hook/started" | "hook/completed" | "account/rateLimits/updated"
            | "item/autoApprovalReview/started" | "item/autoApprovalReview/completed" | "guardianWarning" => {}
            "thread/compacted" => match turn {
                Some(turn) => {
                    dirty.turn(turn);
                }
                None => dirty.turn_rows = true,
            },
            "turn/started" | "turn/completed" => {
                if let Some(turn) = turn {
                    dirty.turn(turn);
                    for carried in data["turn"]["items"].as_array().into_iter().flatten() {
                        match carried["id"].as_str() {
                            Some(id) => dirty.item(turn, id),
                            None => dirty.whole_turn(turn),
                        };
                    }
                }
            }
            "turn/plan/updated" => {
                if let Some(turn) = turn {
                    dirty.turn(turn);
                }
            }
            _ if kind.starts_with("item/") => match (turn, item) {
                (Some(turn), Some(item)) => {
                    dirty.item(turn, item);
                }
                (Some(turn), None) => {
                    dirty.whole_turn(turn);
                }
                (None, _) => {}
            },
            _ => {
                if let Some(turn) = turn {
                    dirty.whole_turn(turn);
                }
            }
        }
        dirty
    }

    /// `of_event`, for an event `detail` has just applied. A Claude
    /// sub-agent's frame or task event changed the Turn holding the call that
    /// started it (`claude::event_turn`), which the event itself may not name:
    /// it can come after its Turn ended, or inside another one.
    pub fn of_applied(detail: &AgentDetail, kind: &str, data: &Value) -> Self {
        let event = &data["event"];
        if !kind.starts_with("claude/") || !crate::claude::subagent_event(event) {
            return Self::of_event(kind, data);
        }
        let mut dirty = Self::default();
        if let Some(turn) = crate::claude::event_turn(detail, data["turnId"].as_str(), event) {
            dirty.whole_turn(&turn);
        }
        dirty
    }

    /// This set of changes, named without comparing (see `Store::commit`'s
    /// scopes), checked against the record `after` them as `between` treats
    /// one: None when its Turns cannot be told apart by ID (for which
    /// `between` changes everything), and a named Turn whose Items cannot be
    /// changes all its Items.
    pub fn identified(mut self, after: &AgentDetail) -> Option<Self> {
        if self.all {
            return Some(self);
        }
        let turns = by_id(&after.turns)?;
        for (id, touched) in &mut self.turns {
            let items = turns.get(id.as_str()).and_then(|turn| split_items(turn));
            if !items.is_some_and(|items| by_id(items).is_some()) {
                touched.all_items = true;
            }
        }
        Some(self)
    }

    /// What changed between two states of a record, by comparing them: for
    /// changes made by code other than one native event (`Store::update`
    /// callers). Unchanged Turns and Items compare equal without being
    /// serialized. Records whose Turns or Items cannot be told apart by ID
    /// change everything.
    pub fn between(before: &AgentDetail, after: &AgentDetail) -> Self {
        let mut dirty = Self::default();
        let (Some(old), Some(_)) = (by_id(&before.turns), by_id(&after.turns)) else { return Self::all() };
        for turn in &after.turns {
            let id = turn["id"].as_str().expect("checked by by_id");
            match old.get(id) {
                Some(previous) if *previous == turn => {}
                Some(previous) => {
                    dirty.turn(id);
                    let (Some(was), Some(now)) = (split_items(previous), split_items(turn)) else {
                        dirty.whole_turn(id);
                        continue;
                    };
                    let Some(was) = by_id(was) else {
                        dirty.whole_turn(id);
                        continue;
                    };
                    for item in now {
                        match item["id"].as_str() {
                            Some(item_id) if was.get(item_id) == Some(&item) => {}
                            Some(item_id) => {
                                dirty.item(id, item_id);
                            }
                            None => {
                                dirty.whole_turn(id);
                                break;
                            }
                        }
                    }
                }
                None => {
                    dirty.whole_turn(id);
                }
            }
        }
        dirty
    }
}

/// Values by ID, or None if one has no string ID or two share one.
fn by_id(values: &[Value]) -> Option<HashMap<&str, &Value>> {
    let mut map = HashMap::with_capacity(values.len());
    for value in values {
        if map.insert(value["id"].as_str()?, value).is_some() {
            return None;
        }
    }
    Some(map)
}

/// A write prepared without the writer (see `plan`): the rows to change,
/// serialized, and the metadata without its `agent`.
pub struct Plan {
    layout: Layout,
    /// The metadata (rows layout), or the whole record (whole layout),
    /// either without its `agent`.
    body: String,
    ops: Vec<Op>,
}

/// One statement of a write, in order. Deleting a Turn or an Item deletes
/// its Items and payloads first, so nothing depends on foreign keys.
enum Op {
    Turn { key: String, ord: usize, items: Option<usize>, data: String },
    TurnOrd { key: String, ord: usize },
    DeleteTurn { key: String },
    /// All Item rows of a Turn now stored whole.
    DeleteItems { turn: String },
    Item { turn: String, key: String, ord: usize, payloads: usize, data: String, previews: Option<String> },
    ItemOrd { turn: String, key: String, ord: usize },
    DeleteItem { turn: String, key: String },
    Payload { turn: String, item: String, field: String, data: String },
    DeletePayload { turn: String, item: String, field: String },
}

/// Prepares writing what `dirty` names of an Agent's record, and its
/// metadata: reads how its rows stand (the caller makes sure nothing else
/// changes them until `apply`; a reader will do) and serializes what
/// changes, so the writer is needed only for `apply`. `detail` is the whole
/// record: Turns and Items it does not have are deleted (use `MetaBody` and
/// `write_meta` for a record loaded without its Turns). A record still stored
/// whole is written whole: only `convert` changes a layout.
pub fn plan(db: &Connection, id: &str, detail: &AgentDetail, dirty: &Dirty) -> Result<Plan> {
    ensure!(detail.agent.id == id, "record of Agent {} written as {id}", detail.agent.id);
    let layout = layout(db, id)?.context("Agent 不存在")?;
    if layout == Layout::Whole {
        return Ok(Plan { layout, body: whole_tail(detail)?, ops: Vec::new() });
    }
    Ok(Plan { layout, ops: plan_turns(db, id, &detail.turns, dirty)?, body: MetaBody::of(detail)?.0 })
}

/// `plan` for the record whose Turns are `turns` and whose metadata is
/// `meta`'s (`meta.turns` is not read), so that a change to the metadata
/// alone is planned without a copy of the Turns. None for a record kept as
/// one body (`Layout::Whole`), which only `plan` plans, from the whole record.
pub fn plan_parts(db: &Connection, id: &str, turns: &[Value], meta: &AgentDetail, dirty: &Dirty) -> Result<Option<Plan>> {
    ensure!(meta.agent.id == id, "record of Agent {} written as {id}", meta.agent.id);
    let layout = layout(db, id)?.context("Agent 不存在")?;
    if layout == Layout::Whole {
        return Ok(None);
    }
    Ok(Some(Plan { layout, ops: plan_turns(db, id, turns, dirty)?, body: MetaBody::of(meta)?.0 }))
}

/// The row changes of `plan` for these Turns.
fn plan_turns(db: &Connection, id: &str, turns: &[Value], dirty: &Dirty) -> Result<Vec<Op>> {
    let mut ops = Vec::new();
    let keys = turn_keys(turns);
    let stored: HashMap<String, (usize, Option<usize>)> = db
        .prepare_cached("SELECT turn_id, ord, items FROM agent_turns WHERE agent_id=?1")?
        .query_map([id], |r| Ok((r.get::<_, String>(0)?, (count(r.get(1)?)?, r.get::<_, Option<i64>>(2)?.map(count).transpose()?))))?
        .collect::<rusqlite::Result<_>>()?;
    let present: HashSet<&str> = keys.iter().map(String::as_str).collect();
    for key in stored.keys().filter(|key| !present.contains(key.as_str())) {
        ops.push(Op::DeleteTurn { key: key.clone() });
    }
    for (ord, (turn, key)) in turns.iter().zip(&keys).enumerate() {
        let old = stored.get(key);
        let items = split_items(turn);
        let touched = if positional(key) { None } else { dirty.turns.get(key) };
        let full = dirty.all || old.is_none() || positional(key) || touched.is_some_and(|t| t.all_items);
        let recounted = old.is_some_and(|(_, n)| *n != items.map(Vec::len));
        if full || dirty.turn_rows || touched.is_some() || recounted {
            let (data, count) = turn_row(turn)?;
            ops.push(Op::Turn { key: key.clone(), ord, items: count, data });
        } else if old.is_some_and(|(o, _)| *o != ord) {
            ops.push(Op::TurnOrd { key: key.clone(), ord });
        }
        match items {
            None => {
                if old.is_some_and(|(_, n)| n.is_some()) {
                    ops.push(Op::DeleteItems { turn: key.clone() });
                }
            }
            Some(items) if full || recounted || touched.is_some() => {
                let named = touched.map(|t| &t.items);
                plan_items(db, id, key, items, full, named, old.is_some(), &mut ops)?;
            }
            Some(_) => {}
        }
    }
    Ok(ops)
}

/// Plans the Items of one Turn: all of them, or those named, new or moved;
/// and deleting the rows of Items it no longer has.
#[allow(clippy::too_many_arguments)]
fn plan_items(db: &Connection, agent: &str, turn: &str, items: &[Value], all: bool,
    named: Option<&HashSet<String>>, existed: bool, ops: &mut Vec<Op>) -> Result<()> {
    let keys = item_keys(items);
    let stored: HashMap<String, usize> = if existed {
        db.prepare_cached("SELECT item_id, ord FROM agent_items WHERE agent_id=?1 AND turn_id=?2")?
            .query_map(params![agent, turn], |r| Ok((r.get::<_, String>(0)?, count(r.get(1)?)?)))?
            .collect::<rusqlite::Result<_>>()?
    } else {
        HashMap::new()
    };
    let present: HashSet<&str> = keys.iter().map(String::as_str).collect();
    for key in stored.keys().filter(|key| !present.contains(key.as_str())) {
        ops.push(Op::DeleteItem { turn: turn.into(), key: key.clone() });
    }
    for (ord, (item, key)) in items.iter().zip(&keys).enumerate() {
        let old = stored.get(key).copied();
        let rewrite = all || old.is_none() || positional(key) || named.is_some_and(|n| n.contains(key));
        if !rewrite {
            if old != Some(ord) {
                ops.push(Op::ItemOrd { turn: turn.into(), key: key.clone(), ord });
            }
            continue;
        }
        let ItemOut { data, previews, payloads } = item_row(item)?;
        ops.push(Op::Item { turn: turn.into(), key: key.clone(), ord, payloads: payloads.len(), data, previews });
        if old.is_some() {
            let fields: Vec<String> = db.prepare_cached("SELECT field FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                .query_map(params![agent, turn, key], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for field in fields.into_iter().filter(|f| !payloads.iter().any(|(name, _)| name == f)) {
                ops.push(Op::DeletePayload { turn: turn.into(), item: key.clone(), field });
            }
        }
        for (field, data) in payloads {
            ops.push(Op::Payload { turn: turn.into(), item: key.clone(), field, data });
        }
    }
    Ok(())
}

/// Writes a plan, in the caller's transaction, with the record's `agent` as
/// it is now (its journal position and unread count). Rows rewritten with
/// what they already held are skipped by the database.
pub fn apply(db: &Connection, id: &str, plan: &Plan, agent: &crate::model::Agent) -> Result<Written> {
    ensure!(!db.is_autocommit(), "Agent records are written inside a transaction");
    ensure!(agent.id == id, "record of Agent {} written as {id}", agent.id);
    ensure!(layout(db, id)? == Some(plan.layout), "Agent {id} was converted or removed since its write was planned");
    let mut written = Written { layout: plan.layout, ..Written::default() };
    if plan.layout == Layout::Whole {
        db.prepare_cached("UPDATE agents SET data=?1 WHERE id=?2")?
            .execute(params![format!("{{\"agent\":{}{}", serde_json::to_string(agent)?, plan.body), id])?;
        written.meta = true;
        return Ok(written);
    }
    written.meta = db.prepare_cached("UPDATE agents SET data=?1 WHERE id=?2 AND data IS NOT ?1")?
        .execute(params![MetaBody(plan.body.clone()).row(agent)?, id])? > 0;
    for op in &plan.ops {
        match op {
            Op::Turn { key, ord, items, data } => {
                written.turns += db.prepare_cached("INSERT INTO agent_turns(agent_id,turn_id,ord,items,data) VALUES(?1,?2,?3,?4,?5)
                    ON CONFLICT(agent_id,turn_id) DO UPDATE SET ord=excluded.ord, items=excluded.items, data=excluded.data
                    WHERE ord IS NOT excluded.ord OR items IS NOT excluded.items OR data IS NOT excluded.data")?
                    .execute(params![id, key, *ord as i64, items.map(|n| n as i64), data])?;
            }
            Op::TurnOrd { key, ord } => {
                written.turns += db.prepare_cached("UPDATE agent_turns SET ord=?3 WHERE agent_id=?1 AND turn_id=?2")?
                    .execute(params![id, key, *ord as i64])?;
            }
            Op::DeleteTurn { key } => written.deleted += delete_turn(db, id, key)?,
            Op::DeleteItems { turn } => {
                db.prepare_cached("DELETE FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2")?.execute(params![id, turn])?;
                written.deleted += db.prepare_cached("DELETE FROM agent_items WHERE agent_id=?1 AND turn_id=?2")?
                    .execute(params![id, turn])?;
            }
            Op::Item { turn, key, ord, payloads, data, previews } => {
                written.items += db.prepare_cached("INSERT INTO agent_items(agent_id,turn_id,item_id,ord,payloads,data,previews) VALUES(?1,?2,?3,?4,?5,?6,?7)
                    ON CONFLICT(agent_id,turn_id,item_id) DO UPDATE SET ord=excluded.ord, payloads=excluded.payloads, data=excluded.data,
                    previews=excluded.previews
                    WHERE ord IS NOT excluded.ord OR payloads IS NOT excluded.payloads OR data IS NOT excluded.data
                    OR previews IS NOT excluded.previews")?
                    .execute(params![id, turn, key, *ord as i64, *payloads as i64, data, previews])?;
            }
            Op::ItemOrd { turn, key, ord } => {
                written.items += db.prepare_cached("UPDATE agent_items SET ord=?4 WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                    .execute(params![id, turn, key, *ord as i64])?;
            }
            Op::DeleteItem { turn, key } => {
                db.prepare_cached("DELETE FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                    .execute(params![id, turn, key])?;
                written.deleted += db.prepare_cached("DELETE FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                    .execute(params![id, turn, key])?;
            }
            Op::Payload { turn, item, field, data } => {
                written.payloads += db.prepare_cached("INSERT INTO agent_payloads(agent_id,turn_id,item_id,field,data) VALUES(?1,?2,?3,?4,?5)
                    ON CONFLICT(agent_id,turn_id,item_id,field) DO UPDATE SET data=excluded.data WHERE data IS NOT excluded.data")?
                    .execute(params![id, turn, item, field, data])?;
            }
            Op::DeletePayload { turn, item, field } => {
                written.deleted += db.prepare_cached("DELETE FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3 AND field=?4")?
                    .execute(params![id, turn, item, field])?;
            }
        }
    }
    Ok(written)
}

/// `plan` and `apply` on one connection, in the caller's transaction.
pub fn write(db: &Connection, id: &str, detail: &AgentDetail, dirty: &Dirty) -> Result<Written> {
    ensure!(!db.is_autocommit(), "Agent records are written inside a transaction");
    let plan = plan(db, id, detail, dirty)?;
    apply(db, id, &plan, &detail.agent)
}

/// Writes only the metadata of an Agent stored as rows (`MetaBody` of a
/// record whose Turns are not needed, with its `agent` as it is now), in the
/// caller's transaction: for changes that leave Turns alone, such as read
/// marks, without loading the Turns. Returns whether it changed. A record
/// stored whole cannot be written this way.
pub fn write_meta(db: &Connection, id: &str, meta: &MetaBody, agent: &crate::model::Agent) -> Result<bool> {
    ensure!(!db.is_autocommit(), "Agent records are written inside a transaction");
    ensure!(agent.id == id, "record of Agent {} written as {id}", agent.id);
    ensure!(layout(db, id)?.context("Agent 不存在")? == Layout::Rows, "Agent {id} is stored whole");
    Ok(db.prepare_cached("UPDATE agents SET data=?1 WHERE id=?2 AND data IS NOT ?1")?
        .execute(params![meta.row(agent)?, id])? > 0)
}

/// Deletes one Turn's rows, its Items' and payloads' first (so this does
/// not depend on foreign keys being enforced). Returns the Turn rows deleted.
fn delete_turn(db: &Connection, agent: &str, turn: &str) -> Result<usize> {
    db.prepare_cached("DELETE FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2")?.execute(params![agent, turn])?;
    db.prepare_cached("DELETE FROM agent_items WHERE agent_id=?1 AND turn_id=?2")?.execute(params![agent, turn])?;
    Ok(db.prepare_cached("DELETE FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?.execute(params![agent, turn])?)
}

/// Deletes all of an Agent's Turn, Item and payload rows (not its `agents`
/// row), in the caller's transaction.
pub fn delete_rows(db: &Connection, agent: &str) -> Result<()> {
    db.prepare_cached("DELETE FROM agent_payloads WHERE agent_id=?1")?.execute([agent])?;
    db.prepare_cached("DELETE FROM agent_items WHERE agent_id=?1")?.execute([agent])?;
    db.prepare_cached("DELETE FROM agent_turns WHERE agent_id=?1")?.execute([agent])?;
    Ok(())
}

/// Inserts every row of an Agent whose rows are absent, in the caller's
/// transaction.
fn insert_rows(db: &Connection, id: &str, rows: &Rows) -> Result<()> {
    let mut turns = db.prepare_cached("INSERT INTO agent_turns(agent_id,turn_id,ord,items,data) VALUES(?1,?2,?3,?4,?5)")?;
    for turn in &rows.turns {
        turns.execute(params![id, turn.key, turn.ord as i64, turn.items.map(|n| n as i64), turn.data])?;
    }
    let mut items = db.prepare_cached("INSERT INTO agent_items(agent_id,turn_id,item_id,ord,payloads,data,previews) VALUES(?1,?2,?3,?4,?5,?6,?7)")?;
    for item in &rows.items {
        items.execute(params![id, item.turn, item.key, item.ord as i64, item.payloads as i64, item.data, item.previews])?;
    }
    let mut payloads = db.prepare_cached("INSERT INTO agent_payloads(agent_id,turn_id,item_id,field,data) VALUES(?1,?2,?3,?4,?5)")?;
    for payload in &rows.payloads {
        payloads.execute(params![id, payload.turn, payload.item, payload.field, payload.data])?;
    }
    Ok(())
}

/// Adds a new Agent in the rows layout, in the caller's transaction, from
/// its `split` (made before the writer is taken).
pub fn insert(db: &Connection, id: &str, rows: &Rows) -> Result<()> {
    ensure!(!db.is_autocommit(), "Agent records are written inside a transaction");
    db.execute("INSERT INTO agents(id,data,layout) VALUES(?1,?2,1)", params![id, rows.meta])?;
    insert_rows(db, id, rows)
}

// ---------------------------------------------------------------------------
// Converting existing records

/// What `convert` did.
#[derive(Debug, Default)]
pub struct Conversion {
    pub converted: Vec<String>,
    /// Agents left stored whole, and why. Core keeps working with them.
    pub failed: Vec<(String, String)>,
    /// The copy of the database taken before the first conversion.
    pub backup: Option<PathBuf>,
}

/// Points in `convert_with` where tests simulate a crash.
#[derive(Debug)]
pub enum Step<'a> {
    /// The backup's path is recorded as pending; nothing is copied yet.
    BackingUp(&'a Path),
    /// The backup was taken and recorded.
    BackedUp(&'a Path),
    /// An Agent's rows are written and checked, not committed yet.
    Checked(&'a str),
    /// An Agent's conversion is committed.
    Converted(&'a str),
}

/// Converts every record still stored whole to rows, one transaction per
/// Agent, and checks each: the rows must assemble to exactly the record the
/// whole row gave, or that Agent stays as it was. The whole row is replaced
/// by the metadata only in that same transaction, and kept in
/// `agent_originals` for ORIGINALS_KEPT. Before the first
/// conversion the database is copied next to `path` (`VACUUM INTO`, which is
/// consistent with the WAL); a conversion interrupted at any point resumes
/// on the next run without a second copy, and a run with nothing left to
/// convert changes nothing. A copy that fails, or that a crash interrupted
/// before it was recorded, is removed and taken again: no incomplete or
/// unrecorded copy is left behind.
pub fn convert(db: &mut Connection, path: &Path) -> Result<Conversion> {
    convert_with(db, path, |_| Ok(()))
}

/// `convert`, calling `step` at each point; an error from it stops the run
/// there, as a crash would (an uncommitted Agent is rolled back).
pub fn convert_with(db: &mut Connection, path: &Path, mut step: impl FnMut(Step<'_>) -> Result<()>) -> Result<Conversion> {
    let ids: Vec<String> = db.prepare("SELECT id FROM agents WHERE layout=0 ORDER BY rowid")?
        .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let mut done = Conversion::default();
    if ids.is_empty() {
        return Ok(done);
    }
    done.backup = back_up(db, path, &mut step)?;
    for id in ids {
        let tx = db.transaction()?;
        match convert_one(&tx, &id) {
            Ok(true) => {
                step(Step::Checked(&id))?;
                tx.commit()?;
                step(Step::Converted(&id))?;
                done.converted.push(id);
            }
            Ok(false) => {}
            Err(error) => {
                drop(tx);
                done.failed.push((id, format!("{error:#}")));
            }
        }
    }
    Ok(done)
}

/// Copies the database next to `path` before records are converted, unless
/// a backup is already recorded and no record was stored whole again since
/// (`revert`); earlier backups stay recorded. The path is recorded as
/// pending first; one
/// an interrupted run left pending may be incomplete and is removed, as is a
/// copy that fails. Returns the new backup.
fn back_up(db: &mut Connection, path: &Path, step: &mut impl FnMut(Step<'_>) -> Result<()>) -> Result<Option<PathBuf>> {
    let meta = |db: &Connection, key: &str| -> Result<Option<String>> {
        Ok(db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [key], |r| r.get(0)).optional()?)
    };
    if let Some(pending) = meta(db, PENDING_KEY)? {
        remove_copy(Path::new(&pending))?;
        db.execute("DELETE FROM workspace_meta WHERE key=?1", [PENDING_KEY])?;
    }
    let recorded = meta(db, BACKUP_KEY)?;
    if recorded.is_some() && meta(db, NEEDED_KEY)?.is_none() {
        return Ok(None);
    }
    let target = backup_path(path)?;
    let name = target.to_str().context("backup path is not UTF-8")?.to_owned();
    db.execute("INSERT OR REPLACE INTO workspace_meta(key,value) VALUES(?1,?2)", params![PENDING_KEY, name])?;
    step(Step::BackingUp(&target))?;
    if let Err(error) = db.execute("VACUUM INTO ?1", [&name]) {
        remove_copy(&target)?;
        db.execute("DELETE FROM workspace_meta WHERE key=?1", [PENDING_KEY])?;
        return Err(anyhow::Error::from(error).context(format!("could not copy the Workspace database to {}", target.display())));
    }
    let tx = db.transaction()?;
    if let Some(previous) = recorded {
        let mut earlier: Vec<String> = meta(&tx, EARLIER_KEY)?.and_then(|list| serde_json::from_str(&list).ok()).unwrap_or_default();
        earlier.push(previous);
        tx.execute("INSERT OR REPLACE INTO workspace_meta(key,value) VALUES(?1,?2)", params![EARLIER_KEY, serde_json::to_string(&earlier)?])?;
    }
    tx.execute("INSERT OR REPLACE INTO workspace_meta(key,value) VALUES(?1,?2)", params![BACKUP_KEY, name])?;
    tx.execute("DELETE FROM workspace_meta WHERE key IN (?1,?2)", [PENDING_KEY, NEEDED_KEY])?;
    tx.commit()?;
    step(Step::BackedUp(&target))?;
    Ok(Some(target))
}

/// Removes an unrecorded (possibly partial) copy of the database.
fn remove_copy(path: &Path) -> Result<()> {
    for suffix in ["", "-journal", "-wal", "-shm"] {
        let file = PathBuf::from(format!("{}{suffix}", path.display()));
        match std::fs::remove_file(&file) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(anyhow::Error::from(error).context(format!("could not remove the incomplete copy {}", file.display()))),
        }
    }
    Ok(())
}

/// Converts one Agent inside the caller's transaction; false if it is not
/// stored whole (any more).
fn convert_one(db: &Connection, id: &str) -> Result<bool> {
    let Some(raw) = db.query_row("SELECT data FROM agents WHERE id=?1 AND layout=0", [id], |r| r.get::<_, String>(0)).optional()? else {
        return Ok(false);
    };
    let detail: AgentDetail = serde_json::from_str(&raw).context("Workspace 记录无法读取")?;
    let rows = split(&detail)?;
    // Rows from anything earlier would be stale.
    delete_rows(db, id)?;
    insert_rows(db, id, &rows)?;
    db.execute("UPDATE agents SET data=?1, layout=1 WHERE id=?2", params![rows.meta, id])?;
    db.execute("INSERT OR REPLACE INTO agent_originals(agent_id,data,converted_at) VALUES(?1,?2,?3)",
        params![id, raw, chrono::Utc::now().to_rfc3339()])?;
    let back = load(db, id, true)?.context("converted Agent is missing")?;
    ensure!(serde_json::to_string(&back)? == serde_json::to_string(&detail)?,
        "its rows do not give back exactly the record it had");
    Ok(true)
}

/// `<name>.before-record-rows-<UTC time>.sqlite` next to the database.
fn backup_path(path: &Path) -> Result<PathBuf> {
    let stem = path.file_stem().context("database path has no file name")?.to_string_lossy();
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
    let mut target = path.with_file_name(format!("{stem}.before-record-rows-{stamp}.sqlite"));
    let mut n = 1;
    while target.exists() {
        n += 1;
        target = path.with_file_name(format!("{stem}.before-record-rows-{stamp}-{n}.sqlite"));
    }
    Ok(target)
}

/// The whole row an Agent had when it was converted, and when that was;
/// kept for ORIGINALS_KEPT.
pub fn original(db: &Connection, id: &str) -> Result<Option<(String, String)>> {
    Ok(db.prepare_cached("SELECT data, converted_at FROM agent_originals WHERE agent_id=?1")?
        .query_row([id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?)
}

/// Forgets the whole rows of conversions older than ORIGINALS_KEPT. Returns
/// how many it dropped.
pub fn expire_originals(db: &Connection) -> Result<usize> {
    let before = (chrono::Utc::now() - ORIGINALS_KEPT).to_rfc3339();
    Ok(db.execute("DELETE FROM agent_originals WHERE converted_at < ?1", [before])?)
}

/// The backup the first conversion took, if one is recorded.
pub fn recorded_backup(db: &Connection) -> Result<Option<String>> {
    Ok(db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [BACKUP_KEY], |r| r.get(0)).optional()?)
}

/// How a damaged record was stood in for (see `store::recover`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Recovery {
    /// Its whole row from before the conversion, with what the journal
    /// replays since; changes the journal cannot replay are missing.
    Original { converted_at: String },
    /// Only its metadata, without Turns.
    WithoutTurns,
}

/// What `revert` salvaged of a damaged record. Nothing is dropped: what
/// could not be given back is marked `_yuzunoSalvage` in the record, and
/// every row it had is kept in `agent_salvage`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Salvage {
    /// Turns and Items given back from their rows.
    pub turns: usize,
    pub items: usize,
    /// Turns whose row was missing or unreadable: kept as marked
    /// placeholders, with whatever Items of theirs were readable.
    pub lost_turns: usize,
    /// Items whose row was missing or unreadable: marked placeholders.
    pub lost_items: usize,
    /// Fields whose payload row was missing or unreadable: their Items keep
    /// the preview, marked.
    pub lost_payloads: usize,
    /// Payload rows of no Item row (in `agent_salvage` only).
    pub stray_payloads: usize,
    /// Its metadata row was unreadable; its record from before the
    /// conversion gave the metadata instead.
    pub metadata_from_original: bool,
    /// Rows copied to `agent_salvage`.
    pub rows_kept: usize,
}

/// What `revert` did.
#[derive(Debug, Default)]
pub struct Reverted {
    /// Stored whole again with everything.
    pub agents: Vec<String>,
    /// Damaged, and stored whole again with every Turn and Item that could
    /// be read (see `Salvage`).
    pub salvaged: Vec<(String, Salvage)>,
    /// Left as they were (rows untouched), and why.
    pub failed: Vec<(String, String)>,
}

/// Stores every record whole again, for an older Core build, keeping all
/// changes made since the conversion; one transaction per Agent. A damaged
/// record keeps every Turn and Item that can be read, with what cannot
/// marked, and all its rows are copied to `agent_salvage` first (with its
/// original, if kept). One whose metadata cannot be read either is left as it
/// is. No backup path is forgotten; the next conversion takes a new backup.
pub fn revert(db: &mut Connection) -> Result<Reverted> {
    let ids: Vec<String> = db.prepare("SELECT id FROM agents WHERE layout=1 ORDER BY rowid")?
        .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    let mut done = Reverted::default();
    for id in ids {
        let tx = db.transaction()?;
        let (detail, salvaged) = match load(&tx, &id, true) {
            Ok(Some(detail)) => (detail, None),
            Ok(None) => continue,
            Err(error) if error.is::<Damaged>() => match salvage(&tx, &id)? {
                Some((detail, mut salvaged)) => {
                    salvaged.rows_kept = keep_rows(&tx, &id)?;
                    (detail, Some(salvaged))
                }
                None => {
                    done.failed.push((id, "its metadata cannot be read and no record from before the conversion is kept; its rows are left as they are".into()));
                    continue;
                }
            },
            Err(error) => {
                done.failed.push((id, format!("{error:#}")));
                continue;
            }
        };
        tx.execute("UPDATE agents SET data=?1, layout=0 WHERE id=?2", params![serde_json::to_string(&detail)?, id])?;
        delete_rows(&tx, &id)?;
        if salvaged.is_none() {
            tx.execute("DELETE FROM agent_originals WHERE agent_id=?1", [&id])?;
        }
        tx.commit()?;
        match salvaged {
            None => done.agents.push(id),
            Some(salvaged) => done.salvaged.push((id, salvaged)),
        }
    }
    if !done.agents.is_empty() || !done.salvaged.is_empty() {
        db.execute("INSERT OR REPLACE INTO workspace_meta(key,value) VALUES(?1,?2)",
            params![NEEDED_KEY, chrono::Utc::now().to_rfc3339()])?;
    }
    Ok(done)
}

/// One Item row as stored: key, position, payload count, data, previews.
type ItemRaw = (String, i64, i64, String, Option<String>);

/// A damaged record as far as its rows can be read: its metadata (or its
/// original's), every Turn and Item row that parses, payloads put back where
/// they can be (else the preview), and marked placeholders for what is
/// missing or unreadable, in order. None if no metadata can be read.
fn salvage(db: &Connection, id: &str) -> Result<Option<(AgentDetail, Salvage)>> {
    let mut report = Salvage::default();
    let Some(meta) = db.query_row("SELECT data FROM agents WHERE id=?1", [id], |r| r.get::<_, String>(0)).optional()? else {
        return Ok(None);
    };
    let mut detail = match from_meta(&meta) {
        Ok(detail) => detail,
        Err(_) => {
            let original = original(db, id)?.and_then(|(data, _)| serde_json::from_str::<AgentDetail>(&data).ok());
            let Some(original) = original else { return Ok(None) };
            report.metadata_from_original = true;
            AgentDetail { turns: Vec::new(), ..original }
        }
    };
    let turns: Vec<(String, Option<i64>, String)> = db
        .prepare("SELECT turn_id, items, data FROM agent_turns WHERE agent_id=?1 ORDER BY ord, turn_id")?
        .query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut items: HashMap<String, Vec<ItemRaw>> = HashMap::new();
    let rows = db.prepare("SELECT turn_id, item_id, ord, payloads, data, previews FROM agent_items WHERE agent_id=?1 ORDER BY turn_id, ord, item_id")?
        .query_map([id], |r| Ok((r.get::<_, String>(0)?, (r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))))?
        .collect::<rusqlite::Result<Vec<(String, ItemRaw)>>>()?;
    for (turn, item) in rows {
        items.entry(turn).or_default().push(item);
    }
    let mut payloads: HashMap<(String, String), Vec<(String, String)>> = HashMap::new();
    let rows = db.prepare("SELECT turn_id, item_id, field, data FROM agent_payloads WHERE agent_id=?1")?
        .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?)))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (turn, item, field, data) in rows {
        payloads.entry((turn, item)).or_default().push((field, data));
    }
    let named = |key: &str| if positional(key) { Value::Null } else { Value::from(key) };
    let lost_turn = |key: &str, note: &str| json!({"id": named(key), "status": "unknown", "items": [], SALVAGE: note});
    for (key, count, data) in turns {
        let rows = items.remove(&key).unwrap_or_default();
        let mut turn = match serde_json::from_str::<Value>(&data) {
            Ok(turn) if turn.is_object() => turn,
            // A whole Turn (no Item rows) that parses is kept as it is.
            Ok(turn) if count.is_none() && rows.is_empty() => turn,
            _ => {
                report.lost_turns += 1;
                lost_turn(&key, "此 Turn 的记录行无法读取，回滚时无法恢复它的字段")
            }
        };
        if turn.is_object() && (count.is_some() || !rows.is_empty()) {
            let expected = count.and_then(|n| usize::try_from(n).ok()).unwrap_or(0);
            turn["items"] = Value::Array(salvage_items(&key, rows, expected, &mut payloads, &mut report));
        }
        report.turns += 1;
        detail.turns.push(turn);
    }
    // Items whose Turn row is gone.
    let mut orphans: Vec<_> = items.into_iter().collect();
    orphans.sort_by(|a, b| a.0.cmp(&b.0));
    for (key, rows) in orphans {
        report.lost_turns += 1;
        let mut turn = lost_turn(&key, "此 Turn 的记录行缺失，回滚时无法恢复它的字段");
        turn["items"] = Value::Array(salvage_items(&key, rows, 0, &mut payloads, &mut report));
        detail.turns.push(turn);
    }
    report.stray_payloads = payloads.values().map(Vec::len).sum();
    Ok(Some((detail, report)))
}

/// One Turn's Items as far as their rows can be read, in position order, a
/// marked placeholder at each position no row fills.
fn salvage_items(turn: &str, rows: Vec<ItemRaw>, expected: usize,
    payloads: &mut HashMap<(String, String), Vec<(String, String)>>, report: &mut Salvage) -> Vec<Value> {
    let mut at: std::collections::BTreeMap<i64, Vec<ItemRaw>> = std::collections::BTreeMap::new();
    for row in rows {
        at.entry(row.1).or_default().push(row);
    }
    let last = at.keys().next_back().map_or(0, |ord| usize::try_from(ord + 1).unwrap_or(0));
    let mut list = Vec::new();
    for position in 0..expected.max(last) {
        match at.remove(&(position as i64)) {
            Some(rows) => list.extend(rows.into_iter().map(|row| salvage_item(turn, row, payloads, report))),
            None => {
                report.lost_items += 1;
                list.push(json!({"id": null, "type": "unavailable", SALVAGE: "此 Item 的记录行缺失，回滚时无法恢复"}));
            }
        }
    }
    // Rows at impossible positions go last.
    for (_, rows) in at {
        list.extend(rows.into_iter().map(|row| salvage_item(turn, row, payloads, report)));
    }
    list
}

/// One Item from its row, with its payloads where they can be read and its
/// previews (marked) where they cannot.
fn salvage_item(turn: &str, (key, _, count, data, previews): ItemRaw,
    payloads: &mut HashMap<(String, String), Vec<(String, String)>>, report: &mut Salvage) -> Value {
    let Ok(mut item) = serde_json::from_str::<Value>(&data) else {
        report.lost_items += 1;
        let id = if positional(&key) { Value::Null } else { Value::from(key.as_str()) };
        return json!({"id": id, "type": "unavailable", SALVAGE: "此 Item 的记录行无法读取，回滚时无法恢复"});
    };
    report.items += 1;
    let found = payloads.remove(&(turn.to_owned(), key)).unwrap_or_default();
    let Some(members) = item.as_object_mut() else { return item };
    if count <= 0 && found.is_empty() {
        return item;
    }
    let mut notes = match members.remove(TRUNCATED) {
        Some(Value::Object(notes)) => notes,
        _ => Map::new(),
    };
    for (field, data) in found {
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            notes.remove(&field);
            members.insert(field, value);
        }
    }
    let previews: Map<String, Value> = previews.and_then(|p| serde_json::from_str(&p).ok()).unwrap_or_default();
    let mut lost = Map::new();
    for field in notes.keys() {
        report.lost_payloads += 1;
        members.insert(field.clone(), previews.get(field).cloned().unwrap_or(Value::Null));
        lost.insert(field.clone(), "完整内容在回滚时缺失，只保留了预览".into());
    }
    if !notes.is_empty() {
        members.insert(TRUNCATED.into(), Value::Object(notes));
        members.insert(SALVAGE.into(), Value::Object(lost));
    }
    item
}

/// Copies every row of an Agent (and its original, if kept) to
/// `agent_salvage`. Returns how many.
fn keep_rows(db: &Connection, id: &str) -> Result<usize> {
    let at = chrono::Utc::now().to_rfc3339();
    let mut kept = 0;
    for sql in [
        "INSERT INTO agent_salvage(agent_id,saved_at,kind,data) SELECT id, ?2, 'metadata', data FROM agents WHERE id=?1",
        "INSERT INTO agent_salvage(agent_id,saved_at,kind,data,previews) SELECT agent_id, ?2, 'original', data, converted_at FROM agent_originals WHERE agent_id=?1",
        "INSERT INTO agent_salvage(agent_id,saved_at,kind,turn_id,ord,count,data) SELECT agent_id, ?2, 'turn', turn_id, ord, items, data FROM agent_turns WHERE agent_id=?1",
        "INSERT INTO agent_salvage(agent_id,saved_at,kind,turn_id,item_id,ord,count,data,previews) SELECT agent_id, ?2, 'item', turn_id, item_id, ord, payloads, data, previews FROM agent_items WHERE agent_id=?1",
        "INSERT INTO agent_salvage(agent_id,saved_at,kind,turn_id,item_id,field,data) SELECT agent_id, ?2, 'payload', turn_id, item_id, field, data FROM agent_payloads WHERE agent_id=?1",
    ] {
        kept += db.execute(sql, params![id, at])?;
    }
    Ok(kept)
}

/// `revert` on the Workspace database at `path`, which no Core may be using
/// (it takes the same lock): for `--revert-record-rows`.
pub fn revert_workspace(path: &Path) -> Result<Reverted> {
    let _lock = crate::store::lock_workspace(path)?;
    let mut db = Connection::open(path)?;
    db.busy_timeout(std::time::Duration::from_secs(3))?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")?;
    migrate(&db)?;
    revert(&mut db)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{DateTime, Utc};
    use serde_json::json;

    /// The tails serialized straight from a record are serde's own output:
    /// the whole row exactly, the metadata row as the same members.
    #[test]
    fn record_tail_is_the_record_without_its_agent() {
        let sparse: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m",
            "color":"sage","threadId":null,"status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        let mut full = sparse.clone();
        full.turns = vec![json!({"id":"t","status":"completed","items":[{"id":"i","type":"agentMessage","text":"q\" {x}"}]})];
        full.history = Some(crate::model::HistoryWindow { next_cursor: Some("c".into()), has_more: true, loaded_count: 1 });
        full.pending = serde_json::from_value(json!([{"id":"p","agentId":"a","method":"m","params":{"z":1,"a":2},"createdAt":"now"}])).unwrap();
        full.artifacts = serde_json::from_value(json!([{"path":"/x","name":"x","kind":"file","sourceItemId":"i"}])).unwrap();
        full.context_usage = crate::model::ContextUsage::measured(10, 100, "t", Utc::now());
        full.message_receipts = serde_json::from_value(json!([{"input":{"clientMessageId":"m","text":"hi"},"status":"accepted","turnId":"t"}])).unwrap();
        full.claude_runtime = Some(Default::default());
        full.codex_handoff = Some(crate::model::CodexHandoff { writer_conflict_at: Some("then".into()), ..Default::default() });
        for detail in [&sparse, &full] {
            let agent = serde_json::to_string(&detail.agent).unwrap();
            assert_eq!(format!("{{\"agent\":{agent}{}", whole_tail(detail).unwrap()), serde_json::to_string(detail).unwrap());
            let meta: Value = serde_json::from_str(&MetaBody::of(detail).unwrap().row(&detail.agent).unwrap()).unwrap();
            let mut expected = serde_json::to_value(detail).unwrap();
            expected.as_object_mut().unwrap().remove("turns");
            assert_eq!(meta, expected);
        }
    }

    fn apply(detail: &mut AgentDetail, kind: &str, data: &Value, at: DateTime<Utc>) {
        if kind.starts_with("claude/") {
            crate::claude::project_event_at(detail, data["turnId"].as_str(), &data["event"], at);
        } else {
            detail.apply_at(kind, data, at);
        }
    }

    fn without_items(turn: &Value) -> Value {
        let mut turn = turn.clone();
        if let Some(members) = turn.as_object_mut() {
            members.remove("items");
        }
        turn
    }

    /// What a write with `named` would leave stale after `before` became
    /// `after`, given what a write finds by itself: new, removed and moved
    /// Turns, and new, removed and moved Items of every Turn it writes or
    /// whose Item count changed.
    fn stale(named: &Dirty, before: &AgentDetail, after: &AgentDetail) -> Option<String> {
        if named.all {
            return None;
        }
        let old = by_id(&before.turns).expect("Turn IDs");
        for turn in &after.turns {
            let id = turn["id"].as_str().expect("Turn ID");
            let Some(previous) = old.get(id) else { continue };
            if *previous == turn {
                continue;
            }
            let touched = named.turns.get(id);
            if without_items(previous) != without_items(turn) && touched.is_none() && !named.turn_rows {
                return Some(format!("Turn {id}'s own fields"));
            }
            let (Some(was), Some(now)) = (split_items(previous), split_items(turn)) else {
                return touched.is_none().then(|| format!("Turn {id} stored whole"));
            };
            if touched.is_none() && was.len() == now.len() {
                if was != now {
                    return Some(format!("Items of Turn {id}, which is not named"));
                }
                continue;
            }
            let was = by_id(was).expect("Item IDs");
            for item in now {
                let item_id = item["id"].as_str().expect("Item ID");
                if was.get(item_id).is_some_and(|w| *w != item)
                    && !touched.is_some_and(|t| t.all_items || t.items.contains(item_id)) {
                    return Some(format!("Item {item_id} of Turn {id}"));
                }
            }
        }
        None
    }

    /// Applies each event to `after`, checks what `of_event` names against
    /// what changed, then brings `before` level (no copy of the record).
    fn check(before: &mut AgentDetail, after: &mut AgentDetail, events: &[(String, Value, DateTime<Utc>)]) -> usize {
        let mut changed = 0;
        for (n, (kind, data, at)) in events.iter().enumerate() {
            apply(after, kind, data, *at);
            if let Some(what) = stale(&Dirty::of_applied(after, kind, data), before, after) {
                panic!("event {n} ({kind}) changed {what} without naming it");
            }
            changed += usize::from(!Dirty::between(before, after).is_meta_only());
            apply(before, kind, data, *at);
        }
        changed
    }

    /// Looking an Item up by ID in any Turn, and rows keyed by position,
    /// read an index, never every Item of the Agent.
    #[test]
    fn item_lookups_use_indexes() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);").unwrap();
        migrate(&db).unwrap();
        for sql in [NEWEST_ITEM, POSITIONAL_ITEMS] {
            let plan: Vec<String> = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap()
                .query_map(params!["a", "x"], |r| r.get::<_, String>(3)).unwrap().map(Result::unwrap).collect();
            let items = plan.iter().find(|step| step.contains(" i ")).unwrap();
            assert!(items.contains("agent_items_by_id") && items.contains("item_id"), "{plan:?}");
        }
    }

    fn record(harness: &str) -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":"a","name":"a","cwd":"/w","model":"m","color":"sage","harness":harness,
            "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},
            "turns":[{"id":"old","status":"completed","items":[{"id":"x","type":"agentMessage","text":"old"}]},
                {"id":"t","status":"inProgress","items":[]}],"pending":[],"artifacts":[],
            "claudeRuntime":{"contextWindow":200000}})).unwrap()
    }

    #[test]
    fn of_event_names_what_codex_events_change() {
        let at = Utc::now();
        let events: Vec<(String, Value, DateTime<Utc>)> = [
            ("turn/started", json!({"turn":{"id":"t","status":"inProgress","items":[]}})),
            ("item/started", json!({"turnId":"t","item":{"id":"c","type":"commandExecution","status":"inProgress"}})),
            ("item/commandExecution/outputDelta", json!({"turnId":"t","itemId":"c","delta":"out\n"})),
            ("item/agentMessage/delta", json!({"turnId":"t","itemId":"m","delta":"Hel"})),
            ("item/agentMessage/delta", json!({"turnId":"t","itemId":"m","delta":"lo"})),
            ("item/reasoning/summaryPartAdded", json!({"turnId":"t","itemId":"r","summaryIndex":1})),
            ("item/reasoning/summaryTextDelta", json!({"turnId":"t","itemId":"r","summaryIndex":1,"delta":"why"})),
            ("item/plan/delta", json!({"turnId":"t","itemId":"p","delta":"1."})),
            ("turn/plan/updated", json!({"turnId":"t","plan":[{"step":"a","status":"pending"}]})),
            ("item/started", json!({"turnId":"t","item":{"id":"k","type":"contextCompaction"}})),
            ("thread/compacted", json!({"turnId":"t"})),
            ("item/completed", json!({"turnId":"t","item":{"id":"k","type":"contextCompaction"}})),
            ("item/started", json!({"turnId":"t","item":{"id":"k2","type":"contextCompaction"}})),
            ("thread/compacted", json!({})),
            ("item/completed", json!({"turnId":"t","item":{"id":"f","type":"fileChange","changes":[{"path":"/w/a"}]}})),
            ("item/completed", json!({"turnId":"t","item":{"id":"m","type":"agentMessage","text":"Hello"}})),
            ("item/started", json!({"turnId":"new","item":{"id":"n","type":"agentMessage","text":""}})),
            ("thread/tokenUsage/updated", json!({"turnId":"t","tokenUsage":{"last":{"totalTokens":5},"modelContextWindow":100}})),
            ("hook/started", json!({"turnId":"t","run":{"id":"h"}})),
            ("account/rateLimits/updated", json!({"rateLimits":{}})),
            ("turn/diff/updated", json!({"turnId":"t","diff":"..."})),
            ("item/autoApprovalReview/started", json!({"turnId":"t","review":{}})),
            ("error", json!({"error":{"message":"x"},"willRetry":true})),
            ("serverRequest/resolved", json!({"requestId":1})),
            ("turn/completed", json!({"turn":{"id":"t","status":"completed","items":[{"id":"c","type":"commandExecution","aggregatedOutput":"all"},{"id":"z","type":"agentMessage","text":"final"}]}})),
            ("turn/started", json!({"turn":{"id":"old","status":"inProgress"}})),
            ("item/agentMessage/delta", json!({"turnId":"old","itemId":"x","delta":" more"})),
        ].into_iter().map(|(k, d)| (k.to_owned(), d, at)).collect();
        let (mut before, mut after) = (record("codex"), record("codex"));
        assert!(check(&mut before, &mut after, &events) > 15);
    }

    #[test]
    fn of_event_names_what_claude_events_change() {
        let at = Utc::now();
        let claude = |event: Value| ("claude/".to_owned() + event["type"].as_str().unwrap(), json!({"type":"event","turnId":"t","event":event}), at);
        let mut events = vec![
            claude(json!({"type":"system","subtype":"init","model":"opus","claude_code_version":"2"})),
            claude(json!({"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","usage":{"input_tokens":10}}}})),
            claude(json!({"type":"stream_event","event":{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}})),
            claude(json!({"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"hmm"}}})),
            claude(json!({"type":"stream_event","event":{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}})),
            claude(json!({"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hi"}}})),
            claude(json!({"type":"stream_event","event":{"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"tool","name":"Bash","input":{}}}})),
            claude(json!({"type":"stream_event","event":{"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\"command\":\"ls\"}"}}})),
            claude(json!({"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":5}}})),
            claude(json!({"type":"system","subtype":"thinking_tokens","tokens":3})),
            claude(json!({"type":"assistant","uuid":"u1","message":{"id":"m1","content":[{"type":"thinking","thinking":"hmm"}]}})),
            claude(json!({"type":"assistant","uuid":"u2","message":{"id":"m1","content":[{"type":"text","text":"Hi"}]}})),
            claude(json!({"type":"assistant","uuid":"u3","message":{"id":"m1","content":[{"type":"tool_use","id":"tool","name":"Bash","input":{"command":"ls"}}]}})),
            claude(json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool","content":"a.rs"}]}})),
            claude(json!({"type":"tool_progress","tool_use_id":"tool","elapsed_time_seconds":3})),
            claude(json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}})),
            claude(json!({"type":"system","subtype":"status","status":"requesting"})),
            claude(json!({"type":"system","subtype":"compact_boundary"})),
            claude(json!({"type":"result","subtype":"success","is_error":false,"result":"Hi","modelUsage":{"opus":{"contextWindow":200000}}})),
        ];
        events.push(("claude/assistant".into(), json!({"turnId":"missing","event":{"type":"assistant","message":{"id":"m","content":[]}}}), at));
        let (mut before, mut after) = (record("claude"), record("claude"));
        assert!(check(&mut before, &mut after, &events) > 10);
    }

    /// A Claude sub-agent's frames and task events change the Turn of its
    /// call, whichever Turn the event names, if any.
    #[test]
    fn of_applied_names_the_turn_of_a_subagents_call() {
        let at = Utc::now();
        let claude = |turn: Value, event: Value| ("claude/".to_owned() + event["type"].as_str().unwrap(), json!({"type":"event","turnId":turn,"event":event}), at);
        let sub = |id: &str| json!({"type":"assistant","uuid":id,"parent_tool_use_id":"agent","message":{"id":id,"content":[
            {"type":"tool_use","id":id,"name":"Read","input":{}}]}});
        let events = vec![
            claude("t".into(), json!({"type":"assistant","uuid":"u","message":{"id":"m","content":[{"type":"tool_use","id":"agent","name":"Agent","input":{}}]}})),
            claude("t".into(), json!({"type":"system","subtype":"task_started","task_id":"task","tool_use_id":"agent","task_type":"local_agent","is_backgrounded":true})),
            claude("t".into(), json!({"type":"result","subtype":"success","is_error":false,"result":""})),
            claude(Value::Null, sub("late")),
            claude("old".into(), sub("elsewhere")),
            claude(Value::Null, json!({"type":"system","subtype":"task_progress","task_id":"task","tool_use_id":"agent","last_tool_name":"Read"})),
            claude(Value::Null, json!({"type":"user","parent_tool_use_id":"agent","message":{"content":[{"type":"tool_result","tool_use_id":"late","content":"x"}]}})),
            claude(Value::Null, json!({"type":"system","subtype":"task_updated","task_id":"task","patch":{"status":"completed"}})),
        ];
        let (mut before, mut after) = (record("claude"), record("claude"));
        assert_eq!(check(&mut before, &mut after, &events), events.len());
        assert_eq!(after.turns[0]["items"].as_array().unwrap().len(), 1, "nothing landed in the Turn an event named");
    }

    /// The real event mix: the newest events of every Agent in a copy of a
    /// Workspace database, replayed onto its record (out of order with it,
    /// which still runs every path the events take). Ignored by default:
    /// `YUZUNO_RECORD_ROWS_DB=<copy> cargo test -p yuzuno-workspace --lib record_rows -- --ignored`.
    #[test]
    #[ignore = "needs YUZUNO_RECORD_ROWS_DB: a copy of a real Workspace database"]
    fn of_event_names_what_real_events_change() {
        let source = std::env::var("YUZUNO_RECORD_ROWS_DB").expect("YUZUNO_RECORD_ROWS_DB");
        let per_agent: usize = std::env::var("YUZUNO_RECORD_ROWS_EVENTS").ok().and_then(|n| n.parse().ok()).unwrap_or(1500);
        let db = Connection::open_with_flags(source, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let ids: Vec<String> = db.prepare("SELECT id FROM agents ORDER BY rowid").unwrap()
            .query_map([], |r| r.get(0)).unwrap().map(Result::unwrap).collect();
        let mut kinds: HashMap<String, usize> = HashMap::new();
        for id in ids {
            let data: String = db.query_row("SELECT data FROM agents WHERE id=?1", [&id], |r| r.get(0)).unwrap();
            let detail: AgentDetail = serde_json::from_str(&data).unwrap();
            let mut events: Vec<(String, Value, DateTime<Utc>)> = db
                .prepare("SELECT kind, data, at FROM journal WHERE agent_id=?1 ORDER BY seq DESC LIMIT ?2").unwrap()
                .query_map(params![id, per_agent as i64], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))).unwrap()
                .map(|row| {
                    let (kind, data, at) = row.unwrap();
                    let at = DateTime::parse_from_rfc3339(&at).map_or_else(|_| Utc::now(), |t| t.with_timezone(&Utc));
                    (kind, serde_json::from_str(&data).unwrap(), at)
                }).collect();
            events.reverse();
            for (kind, _, _) in &events {
                *kinds.entry(kind.clone()).or_default() += 1;
            }
            let (mut before, mut after) = (detail.clone(), detail);
            let changed = check(&mut before, &mut after, &events);
            println!("Agent {}: {} events, {changed} changed Turns", &id[..8], events.len());
        }
        let mut kinds: Vec<_> = kinds.into_iter().collect();
        kinds.sort_by(|a, b| b.1.cmp(&a.1));
        println!("kinds: {kinds:?}");
    }
}
