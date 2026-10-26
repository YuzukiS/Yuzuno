//! Agent records stored as rows: the only copy of an Agent's history (T-140).
//!
//! Core never holds, copies or compares a whole history. It keeps in memory
//! an active Agent's metadata and open Turns (`store`), and every read or
//! change names the Turns it needs; here they are read and written one Turn
//! at a time:
//!
//! - `agents.data`: the record without its Turns and message receipts (the
//!   metadata).
//! - `agent_turns`, keyed `(agent_id, turn_id)`, ordered by `ord` (0..n):
//!   each Turn without its Items (`items` is their count in the row).
//! - `agent_items`, keyed `(agent_id, turn_id, item_id)`, ordered by `ord`
//!   within the Turn: each Item with `null` in place of each large field,
//!   which it notes under `_yuzunoTruncated` (the client view's annotation),
//!   and in `previews` the client view's preview of each. Item IDs repeat
//!   across Turns, so everything is keyed by Turn.
//! - `agent_payloads`, keyed `(agent_id, turn_id, item_id, field)`: the full
//!   value of each large field.
//! - `agent_item_keys`: what finds an Item without reading its Turn: a user
//!   message's client ID and native uuid, a Claude task, a running task, a
//!   Codex child thread (see `index_keys`).
//! - `agent_receipts`, keyed `(agent_id, client_id)`: message receipts, which
//!   grow with every message. None is kept in memory: they are read by client
//!   ID, by Turn, or (those not settled) when a change runs.
//! - `agent_stream_chunks`: the start of a streamed field Core holds only the
//!   end of in memory (`SPILLED`), in order. Read with payloads, the field is
//!   its chunks and then its value; read without, its value and the note.
//!
//! A Turn is read with its payloads (exactly as written) or without them,
//! each large field its preview and noted, as clients are sent it. Core
//! works on Turns read without payloads: an Item written back with a noted
//! field equal to its stored preview keeps that payload row (`item_out`).
//!
//! An active Agent's Turn in memory may hold, in place of a run of its ended
//! Items, a gap (`GAP`): those Items are only in rows, and a write keeps
//! their rows as they are (moved if Items before them were added or removed).
//!
//! A Turn needs a string ID no other Turn of the Agent has. Items without a
//! usable ID (missing, not a string, repeated in their Turn, or starting with
//! `~`) are keyed by their position in the Turn instead (`~3`); a Turn is
//! always read and written with all its Items.
//!
//! Rows that do not fit together (missing, extra, out of order, unreadable)
//! are `Damaged`: an error for that Agent only.
pub mod window;

use crate::model::{AgentDetail, MessageReceipt};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::ser::{Serialize, SerializeMap, Serializer};
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

#[cfg(test)]
thread_local! {
    /// How many Items `plan_items` serialized on this thread to write them.
    pub(crate) static PLANNED_ITEMS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
    /// How many Turns were read (assembled from their rows) on this thread.
    pub(crate) static TURNS_READ: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Item annotation naming each field stored as a payload: the client
/// view's, with its full size, which end the preview keeps, and its lines.
pub const TRUNCATED: &str = crate::client_view::TRUNCATED;
/// Prefix of Item keys given by position. IDs starting with it are keyed by
/// position too, so a positional key never equals an ID used as a key.
const POSITIONAL: char = '~';
/// A gap entry of a Turn in memory: `{"from": its first Item's stored
/// position, "count": its Items}`. Its ID never equals an Item key.
pub const GAP: &str = "_yuzunoGap";
const GAP_ID: &str = "\u{1}gap:";
/// Item annotation of a streamed field whose start is in chunk rows: by
/// field, `{"bytes": .., "lines": ..}` of what the chunks hold.
pub const SPILLED: &str = "_yuzunoSpilled";

/// Inserts `text` into `item`'s string `field` at byte `at` of the field
/// as stored whole, which counts its start written out (`SPILLED`). False,
/// and nothing changed, where `at` is in that start or not a character
/// boundary of what memory holds.
pub fn insert_text(item: &mut Value, field: &str, at: usize, text: &str) -> bool {
    let start = item[SPILLED][field]["bytes"].as_u64().map_or(0, |bytes| bytes as usize);
    if item[field].is_null() {
        item[field] = Value::String(String::new());
    }
    let Some(Value::String(held)) = item.get_mut(field) else { return false };
    match at.checked_sub(start).filter(|place| held.is_char_boundary(*place)) {
        Some(place) => {
            held.insert_str(place, text);
            true
        }
        None => false,
    }
}

/// The gap standing for `count` Items stored from position `from`.
pub fn gap(from: usize, count: usize) -> Value {
    serde_json::json!({"id": format!("{GAP_ID}{from}"), GAP: {"from": from, "count": count}})
}

/// A gap's first stored position and its Item count.
pub fn gap_of(item: &Value) -> Option<(usize, usize)> {
    let gap = item.get(GAP)?;
    Some((usize::try_from(gap["from"].as_u64()?).ok()?, usize::try_from(gap["count"].as_u64()?).ok()?))
}

/// How many Items a Turn's Item array stands for, its gaps' included.
pub fn item_count(items: &[Value]) -> usize {
    items.iter().map(|item| gap_of(item).map_or(1, |(_, count)| count)).sum()
}

/// A streamed field's start, moved out of memory (`SPILLED`).
#[derive(Clone)]
pub struct Chunk {
    pub turn: String,
    pub item: String,
    pub field: String,
    pub data: String,
}

/// A write that would store an Item a gap of its Turn already holds: the
/// Item was not loaded into the Turn before the change. Nothing is written.
#[derive(Debug)]
pub struct GapConflict {
    pub turn: String,
    pub item: String,
}

impl std::fmt::Display for GapConflict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Item {} of Turn {} is stored in a part of the Turn not in memory", self.item, self.turn)
    }
}

impl std::error::Error for GapConflict {}
// The SQL below selects positional keys as `>='~' AND <char(127)`.
const _: () = assert!(POSITIONAL as u32 == 0x7e);
/// `workspace_meta` key holding which session store the rows are written by.
pub const STORE_KEY: &str = "sessionStore";
/// This store. A Workspace whose Agents were written by an earlier one is not
/// opened (see `check_store`).
pub const STORE_VERSION: &str = "2";

/// An Agent's stored record cannot be assembled: its rows are missing,
/// extra, out of order or unreadable. It concerns that Agent only.
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

/// Runs on every open: creates the tables and indexes.
pub fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_turns(
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            turn_id TEXT NOT NULL, ord INTEGER NOT NULL,
            -- Its Item rows; NULL when data is the whole Turn (no Item array).
            items INTEGER,
            data TEXT NOT NULL,
            PRIMARY KEY(agent_id, turn_id));
        CREATE INDEX IF NOT EXISTS agent_turns_by_ord ON agent_turns(agent_id, ord);
        -- The open Turns, which an active Agent keeps in memory.
        CREATE INDEX IF NOT EXISTS agent_turns_open ON agent_turns(agent_id, ord)
            WHERE json_extract(data,'$.status')='inProgress';
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
        CREATE TABLE IF NOT EXISTS agent_item_keys(
            agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL,
            kind TEXT NOT NULL, key TEXT NOT NULL,
            FOREIGN KEY(agent_id, turn_id, item_id) REFERENCES agent_items(agent_id, turn_id, item_id) ON DELETE CASCADE);
        CREATE INDEX IF NOT EXISTS agent_item_keys_by_key ON agent_item_keys(agent_id, kind, key);
        CREATE INDEX IF NOT EXISTS agent_item_keys_by_item ON agent_item_keys(agent_id, turn_id, item_id);
        CREATE TABLE IF NOT EXISTS agent_receipts(
            agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
            client_id TEXT NOT NULL, ord INTEGER NOT NULL,
            -- Accepted, rejected or of unknown delivery: nothing changes it
            -- but a binding to its Turn.
            settled INTEGER NOT NULL,
            -- The Turn it was bound to or accepted by.
            turn_id TEXT,
            data TEXT NOT NULL,
            PRIMARY KEY(agent_id, client_id));
        CREATE INDEX IF NOT EXISTS agent_receipts_by_turn ON agent_receipts(agent_id, turn_id);
        CREATE INDEX IF NOT EXISTS agent_receipts_open ON agent_receipts(agent_id, ord) WHERE settled=0;
        CREATE TABLE IF NOT EXISTS agent_stream_chunks(
            agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, item_id TEXT NOT NULL, field TEXT NOT NULL,
            seq INTEGER NOT NULL, data TEXT NOT NULL,
            PRIMARY KEY(agent_id, turn_id, item_id, field, seq),
            FOREIGN KEY(agent_id, turn_id, item_id) REFERENCES agent_items(agent_id, turn_id, item_id) ON DELETE CASCADE);
        -- Every Core enables foreign keys; only a manual edit without them
        -- can leave rows behind.
        DELETE FROM agent_turns WHERE agent_id NOT IN (SELECT id FROM agents);
        DELETE FROM agent_receipts WHERE agent_id NOT IN (SELECT id FROM agents);
        DELETE FROM agent_items WHERE NOT EXISTS (SELECT 1 FROM agent_turns t
            WHERE t.agent_id=agent_items.agent_id AND t.turn_id=agent_items.turn_id);
        DELETE FROM agent_payloads WHERE NOT EXISTS (SELECT 1 FROM agent_items i
            WHERE i.agent_id=agent_payloads.agent_id AND i.turn_id=agent_payloads.turn_id AND i.item_id=agent_payloads.item_id);
        DELETE FROM agent_item_keys WHERE NOT EXISTS (SELECT 1 FROM agent_items i
            WHERE i.agent_id=agent_item_keys.agent_id AND i.turn_id=agent_item_keys.turn_id AND i.item_id=agent_item_keys.item_id);
        DELETE FROM agent_stream_chunks WHERE NOT EXISTS (SELECT 1 FROM agent_items i
            WHERE i.agent_id=agent_stream_chunks.agent_id AND i.turn_id=agent_stream_chunks.turn_id
            AND i.item_id=agent_stream_chunks.item_id);",
    )?;
    window::migrate(db)?;
    Ok(())
}

/// Opens only a Workspace whose Agents this store wrote, or one with no
/// Agents yet (which `mark_store` then marks as its own). Agents written by
/// an earlier Core keep their Turns in another form (a whole row, or
/// receipts in the metadata); they are not read or changed: no old record is
/// converted. Only read, before anything is written to the file, so an
/// earlier Core's Workspace is refused as it was (its schema, journal mode
/// and pages untouched). This is a product constraint, with what the new
/// format must still guarantee: docs/adr/0002-session-store-new-data-directory.md.
pub fn check_store(db: &Connection) -> Result<()> {
    let has = |table: &str| -> Result<bool> {
        Ok(db.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)", [table], |r| r.get(0))?)
    };
    let marked: Option<String> = if has("workspace_meta")? {
        db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [STORE_KEY], |r| r.get(0)).optional()?
    } else {
        None
    };
    match marked.as_deref() {
        Some(STORE_VERSION) => Ok(()),
        Some(other) => bail!("此 Workspace 的会话记录由会话存储 {other} 写入，这个 Core 不认识；请使用写入它的 Core"),
        None => {
            let agents: i64 = if has("agents")? { db.query_row("SELECT COUNT(*) FROM agents", [], |r| r.get(0))? } else { 0 };
            ensure!(agents == 0, "此 Workspace 的 {agents} 个 Agent 由旧版会话存储写入；新会话存储不读取、不转换旧记录。\
                请使用新的数据目录（任务板按切换窗口说明另行迁出），或继续使用旧版 Core");
            Ok(())
        }
    }
}

/// Marks a Workspace `check_store` let open as this store's: one with no
/// Agents is marked once its schema exists; a marked one is left as it is.
pub fn mark_store(db: &Connection) -> Result<()> {
    db.execute("INSERT OR IGNORE INTO workspace_meta(key,value) VALUES(?1,?2)", params![STORE_KEY, STORE_VERSION])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Rows in memory

/// One Agent's rows, as `split` produces them for a new Agent.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Rows {
    /// `agents.data`: the record without `turns` and `messageReceipts`.
    pub meta: String,
    pub turns: Vec<TurnRow>,
    pub items: Vec<ItemRow>,
    pub payloads: Vec<PayloadRow>,
    pub keys: Vec<KeyRow>,
    pub receipts: Vec<ReceiptRow>,
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

#[derive(Clone, Debug, PartialEq)]
pub struct KeyRow {
    pub turn: String,
    pub item: String,
    pub kind: &'static str,
    pub key: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReceiptRow {
    pub client: String,
    pub settled: bool,
    pub turn: Option<String>,
    pub data: String,
}

/// A payload's value as read: parsed from the row's text where SQLite holds
/// it, without first copying it into a String (T-140), or what its text gave
/// instead, which `fill` reports where it reaches it.
pub type Parsed = std::result::Result<Value, serde_json::Error>;

/// A `data` column read as `Parsed`. A value that is not text, or not
/// UTF-8, is the same database error it is when read as a String (both go
/// through `ValueRef::as_str`); only text that is not JSON is left to `fill`.
struct Json(Parsed);

impl rusqlite::types::FromSql for Json {
    fn column_result(value: rusqlite::types::ValueRef<'_>) -> rusqlite::types::FromSqlResult<Self> {
        Ok(Json(serde_json::from_str(value.as_str()?)))
    }
}

/// Item row keys for a Turn's Items: the ID itself when it is a string,
/// unique in the Turn and not starting with `~`; otherwise `~` and the
/// position.
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

fn item_keys(items: &[Value]) -> Vec<String> {
    keys(items.iter().map(|i| i["id"].as_str()))
}

/// A Turn's row key: its ID, which must be a string and not start with `~`.
fn turn_key(turn: &Value) -> Result<String> {
    let id = turn["id"].as_str().context("Turn without an ID cannot be stored")?;
    ensure!(!id.is_empty() && !positional(id), "Turn ID {id:?} cannot be stored");
    Ok(id.to_owned())
}

/// A Turn's Items when they get rows of their own: it is an object with an
/// Item array. Otherwise its row holds the whole Turn.
fn split_items(turn: &Value) -> Option<&Vec<Value>> {
    turn.as_object()?.get("items")?.as_array()
}

/// An object serialized with some members' values replaced in place, one
/// left out and optionally one member added at the end, without copying
/// the rest.
struct Members<'a> {
    members: &'a Map<String, Value>,
    replaced: &'a [(&'a str, Value)],
    skipped: Option<&'a str>,
    added: Option<(&'static str, &'a Value)>,
}

impl Serialize for Members<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(None)?;
        for (key, value) in self.members {
            if self.skipped == Some(key.as_str()) {
                continue;
            }
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
            let count = item_count(items);
            let replaced = [("items", Value::from(count))];
            Ok((serde_json::to_string(&Members { members, replaced: &replaced, skipped: None, added: None })?, Some(count)))
        }
        _ => Ok((serde_json::to_string(turn)?, None)),
    }
}

/// What finds an Item without reading its Turn (`agent_item_keys`), from its
/// row's own fields (never payloads: a task record is never trimmed, see
/// `client_view::trim_field`):
/// - `client`: a user message's client ID (a receipt's message, a follow-up);
/// - `uuid`: a user message's native uuid (Claude checkpoints);
/// - `task`: a Claude sub-agent's or background task's task ID;
/// - `running`: such a task still able to report, keyed by the Item's ID;
/// - `child`: a Codex sub-agent's thread (`subAgentActivity`);
/// - `user`, `question`: a user message, an async question, by the Item's
///   ID: what a conversation window lists for every Turn (`window::sparse`).
pub fn index_keys(item: &Value) -> Vec<(&'static str, String)> {
    let mut keys = Vec::new();
    let mut add = |kind: &'static str, value: &Value| {
        if let Some(key) = value.as_str().filter(|key| !key.is_empty()) {
            keys.push((kind, key.to_owned()));
        }
    };
    match item["type"].as_str() {
        Some("userMessage") => {
            add("client", &item["clientId"]);
            add("uuid", &item["nativeUuid"]);
            add("user", &item["id"]);
        }
        Some("agentMessage") if item["delivery"] == "async" && item["questions"].as_array().is_some_and(|q| !q.is_empty()) => {
            add("question", &item["id"]);
        }
        Some("subAgentActivity") => add("child", &item["agentThreadId"]),
        _ => {}
    }
    add("task", &item["foregroundTaskId"]);
    for record in crate::claude::TASK_RECORDS {
        add("task", &item[record]["taskId"]);
        if crate::claude::subagent_running(&item[record]) {
            add("running", &item["id"]);
        }
    }
    keys
}

/// An Item's row: its data, its previews, the payloads to write (field,
/// full value as JSON), the payload fields it keeps as stored, and its keys.
struct ItemOut {
    data: String,
    previews: Option<String>,
    payloads: Vec<(String, String)>,
    kept: Vec<String>,
    keys: Vec<(&'static str, String)>,
}

impl ItemOut {
    fn payload_count(&self) -> usize {
        self.payloads.len() + self.kept.len()
    }
}

/// An Item's row. A large field (`client_view::trim_field`) of an Item that
/// is not conversation text becomes a payload, with its preview in the row.
/// A field the Item notes (it was read without its payloads) and that still
/// holds the preview it was stored with (`stored`) keeps its payload row as
/// it is; one the Item changed since is a field like any other.
fn item_out(item: &Value, stored: Option<&Map<String, Value>>) -> Result<ItemOut> {
    let keys = index_keys(item);
    let Some(members) = item.as_object() else {
        return Ok(ItemOut { data: serde_json::to_string(item)?, previews: None, payloads: Vec::new(), kept: Vec::new(), keys });
    };
    let noted = members.get(TRUNCATED).and_then(Value::as_object);
    let whole = crate::client_view::whole(item);
    let mut replaced = Vec::new();
    let mut notes = Map::new();
    let mut previews = Map::new();
    let mut payloads = Vec::new();
    let mut kept = Vec::new();
    for (key, value) in members {
        if key == TRUNCATED {
            continue;
        }
        if let Some(note) = noted.and_then(|noted| noted.get(key)) {
            // Its payload is in the row it was read from: an Item read
            // without payloads is never written under another key.
            ensure!(stored.is_some(), "Item {} was read without its payloads and has no row to keep them in", item["id"]);
            if stored.and_then(|stored| stored.get(key)) == Some(value) {
                notes.insert(key.clone(), note.clone());
                previews.insert(key.clone(), value.clone());
                replaced.push((key.as_str(), Value::Null));
                kept.push(key.clone());
                continue;
            }
        }
        if whole {
            continue;
        }
        if let Some((preview, note)) = crate::client_view::trim_field(item, key, value) {
            payloads.push((key.clone(), serde_json::to_string(value)?));
            notes.insert(key.clone(), note);
            previews.insert(key.clone(), preview);
            replaced.push((key.as_str(), Value::Null));
        }
    }
    if notes.is_empty() {
        let data = serde_json::to_string(&Members { members, replaced: &[], skipped: noted.map(|_| TRUNCATED), added: None })?;
        return Ok(ItemOut { data, previews: None, payloads, kept, keys });
    }
    let notes = Value::Object(notes);
    let data = serde_json::to_string(&Members { members, replaced: &replaced, skipped: noted.map(|_| TRUNCATED),
        added: Some((TRUNCATED, &notes)) })?;
    Ok(ItemOut { data, previews: Some(serde_json::to_string(&previews)?), payloads, kept, keys })
}

/// The Item as read without its payloads: each field `item_out` stores as a
/// payload replaced by its preview and noted (what an active Agent keeps in
/// memory of an Item that ended, `store`). An Item already so is unchanged.
pub fn compact(item: &mut Value) {
    if crate::client_view::whole(item) {
        return;
    }
    let Some(fields) = item.as_object() else { return };
    let trimmed: Vec<(String, Value, Value)> = fields.iter()
        .filter_map(|(key, value)| crate::client_view::trim(item, key, value).map(|(preview, note)| (key.clone(), preview, note)))
        .collect();
    if trimmed.is_empty() {
        return;
    }
    let mut notes = item[TRUNCATED].as_object().cloned().unwrap_or_default();
    for (key, preview, note) in trimmed {
        item[&key] = preview;
        notes.insert(key, note);
    }
    item[TRUNCATED] = Value::Object(notes);
}

/// Whether the Item `held` (as read without payloads, `compact`) stands for
/// `whole`: the same, but each field it notes as stored apart, which is that
/// field's preview, and its time where `whole` has none. A snapshot merge
/// keeps such an Item as it is, so an unchanged Item is never rewritten.
pub fn holds(held: &Value, whole: &Value) -> bool {
    if held == whole {
        return true;
    }
    let (Some(h), Some(w)) = (held.as_object(), whole.as_object()) else { return false };
    let notes = h.get(TRUNCATED).and_then(Value::as_object);
    let time = crate::conversation_time::ITEM_TIME;
    let skipped = |key: &str| key == TRUNCATED || (key == time && !w.contains_key(key));
    if h.keys().filter(|key| !skipped(key)).count() != w.len() {
        return false;
    }
    w.iter().all(|(key, value)| match notes.and_then(|notes| notes.get(key)) {
        Some(note) => crate::client_view::trim_field(whole, key, value)
            .is_some_and(|(preview, made)| h.get(key) == Some(&preview) && note == &made),
        None => h.get(key) == Some(value),
    })
}

/// The metadata row of a record (`agents.data`): everything but its Turns
/// and message receipts, serialized straight from it (nothing is copied
/// first) exactly as `AgentDetail` serializes those members.
pub struct MetaBody(String);

/// The members after `agent`.
struct AfterAgent<'a>(&'a AgentDetail);

impl Serialize for AfterAgent<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        // Listed in full, so a new field of AgentDetail cannot be left out
        // silently: it does not compile until it is added here.
        let AgentDetail { agent: _, turns: _, history, pending, artifacts, context_usage, message_receipts: _,
            claude_runtime, codex_handoff } = self.0;
        let mut map = serializer.serialize_map(None)?;
        if history.is_some() {
            map.serialize_entry("history", history)?;
        }
        map.serialize_entry("pending", pending)?;
        map.serialize_entry("artifacts", artifacts)?;
        map.serialize_entry("contextUsage", context_usage)?;
        if claude_runtime.is_some() {
            map.serialize_entry("claudeRuntime", claude_runtime)?;
        }
        if codex_handoff.is_some() {
            map.serialize_entry("codexHandoff", codex_handoff)?;
        }
        map.end()
    }
}

impl MetaBody {
    pub fn of(detail: &AgentDetail) -> Result<Self> {
        let mut rest = serde_json::to_string(&AfterAgent(detail))?;
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

/// The record a metadata row describes, with no Turns or receipts yet.
pub(crate) fn from_meta(text: &str) -> Result<AgentDetail> {
    let mut value: Value = serde_json::from_str(text).context("Workspace 记录无法读取")?;
    let members = value.as_object_mut().context("Agent metadata is not an object")?;
    ensure!(!members.contains_key("turns"), "Agent metadata row carries Turns");
    ensure!(!members.contains_key("messageReceipts"), "Agent metadata row carries message receipts");
    members.insert("turns".into(), Value::Array(Vec::new()));
    serde_json::from_value(value).context("Workspace 记录无法读取")
}

/// Whether nothing changes a receipt any more but a binding: it was
/// accepted or rejected, or its delivery is unknown for good.
pub fn settled(receipt: &MessageReceipt) -> bool {
    matches!(receipt.status.as_str(), "accepted" | "rejected" | "unknown")
}

/// The Turn a receipt is kept with: the one its message was bound to, else
/// the one that accepted it.
fn receipt_turn(receipt: &MessageReceipt) -> Option<&str> {
    receipt.binding.as_ref().map(|b| b.turn_id.as_str()).or(receipt.turn_id.as_deref())
}

fn receipt_row(receipt: &MessageReceipt) -> Result<ReceiptRow> {
    Ok(ReceiptRow { client: receipt.input.client_message_id.clone(), settled: settled(receipt),
        turn: receipt_turn(receipt).map(str::to_owned), data: serde_json::to_string(receipt)? })
}

/// The rows of a new record.
pub fn split(detail: &AgentDetail) -> Result<Rows> {
    let mut rows = Rows { meta: MetaBody::of(detail)?.row(&detail.agent)?, ..Rows::default() };
    let mut seen = HashSet::new();
    for (ord, turn) in detail.turns.iter().enumerate() {
        let key = turn_key(turn)?;
        ensure!(seen.insert(key.clone()), "Turn {key} appears twice");
        let (data, items) = turn_row(turn)?;
        if let Some(list) = split_items(turn) {
            for (item_ord, (item, item_key)) in list.iter().zip(item_keys(list)).enumerate() {
                ensure!(gap_of(item).is_none(), "a new record's Turn {key} holds a gap");
                let out = item_out(item, None)?;
                let count = out.payload_count();
                for (field, data) in out.payloads {
                    rows.payloads.push(PayloadRow { turn: key.clone(), item: item_key.clone(), field, data });
                }
                for (kind, value) in out.keys {
                    rows.keys.push(KeyRow { turn: key.clone(), item: item_key.clone(), kind, key: value });
                }
                rows.items.push(ItemRow { turn: key.clone(), key: item_key, ord: item_ord, payloads: count, data: out.data,
                    previews: out.previews });
            }
        }
        rows.turns.push(TurnRow { key, ord, items, data });
    }
    for receipt in &detail.message_receipts {
        rows.receipts.push(receipt_row(receipt)?);
    }
    Ok(rows)
}

/// One Turn from its row, its Item rows (in any order) and, with payloads,
/// the payload rows of those Items by Item key.
fn assemble_turn(agent: &str, row: TurnRow, mut items: Vec<ItemRow>,
    fields: &mut HashMap<String, Vec<(String, Parsed)>>, payloads: bool) -> Result<Value> {
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
                fill(&mut value, fields.remove(&item.key).unwrap_or_default(), item.payloads)
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
fn fill(item: &mut Value, payloads: Vec<(String, Parsed)>, expected: usize) -> Result<()> {
    ensure!(payloads.len() == expected, "{} of its {expected} payload rows", payloads.len());
    let members = item.as_object_mut().context("Item with payloads is not an object")?;
    let Some(Value::Object(mut notes)) = members.remove(TRUNCATED) else {
        bail!("Item with payloads does not note them");
    };
    for (field, data) in payloads {
        ensure!(notes.remove(&field).is_some(), "payload {field} is not noted");
        let value = data.context("Workspace 记录无法读取")?;
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

fn item_from_row(r: &rusqlite::Row) -> rusqlite::Result<ItemRow> {
    Ok(ItemRow { turn: r.get(0)?, key: r.get(1)?, ord: count(r.get(2)?)?, payloads: count(r.get(3)?)?, data: r.get(4)?,
        previews: r.get(5)? })
}

fn turn_from_row(r: &rusqlite::Row) -> rusqlite::Result<TurnRow> {
    Ok(TurnRow { key: r.get(0)?, ord: count(r.get(1)?)?, items: r.get::<_, Option<i64>>(2)?.map(count).transpose()?, data: r.get(3)? })
}

/// Whether there is such an Agent.
pub fn exists(db: &Connection, id: &str) -> Result<bool> {
    Ok(db.prepare_cached("SELECT EXISTS(SELECT 1 FROM agents WHERE id=?1)")?.query_row([id], |r| r.get(0))?)
}

/// The record without its Turns and receipts.
pub fn load_meta(db: &Connection, id: &str) -> Result<Option<AgentDetail>> {
    let Some(data) = db.prepare_cached("SELECT data FROM agents WHERE id=?1")?
        .query_row([id], |r| r.get::<_, String>(0)).optional()? else {
        return Ok(None);
    };
    Ok(Some(from_meta(&data).map_err(|e| damaged(id, e))?))
}

/// How many Turns the Agent has.
pub fn turn_count(db: &Connection, id: &str) -> Result<usize> {
    Ok(count(db.prepare_cached("SELECT COUNT(*) FROM agent_turns WHERE agent_id=?1")?.query_row([id], |r| r.get(0))?)?)
}

/// The IDs of the newest `n` Turns, oldest first.
pub fn newest_turns(db: &Connection, id: &str, n: usize) -> Result<Vec<String>> {
    let mut ids: Vec<String> = db.prepare_cached("SELECT turn_id FROM agent_turns WHERE agent_id=?1 ORDER BY ord DESC LIMIT ?2")?
        .query_map(params![id, n as i64], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    ids.reverse();
    Ok(ids)
}

/// The newest `n` Turns' IDs and statuses, oldest first (no Item is read).
pub fn newest_turn_states(db: &Connection, id: &str, n: usize) -> Result<Vec<(String, Option<String>)>> {
    let mut states: Vec<(String, Option<String>)> = db.prepare_cached(
        "SELECT turn_id, json_extract(data,'$.status') FROM agent_turns WHERE agent_id=?1 ORDER BY ord DESC LIMIT ?2")?
        .query_map(params![id, n as i64], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    states.reverse();
    Ok(states)
}

/// The IDs of every Turn, oldest first (IDs only: no Turn is read).
pub fn turn_ids(db: &Connection, id: &str) -> Result<Vec<String>> {
    Ok(db.prepare_cached("SELECT turn_id FROM agent_turns WHERE agent_id=?1 ORDER BY ord")?
        .query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

/// The IDs of the Turns still in progress, oldest first.
pub fn open_turns(db: &Connection, id: &str) -> Result<Vec<String>> {
    Ok(db.prepare_cached("SELECT turn_id FROM agent_turns INDEXED BY agent_turns_open
        WHERE agent_id=?1 AND json_extract(data,'$.status')='inProgress' ORDER BY ord")?
        .query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

/// Whether the Agent has a Turn with this ID.
pub fn has_turn(db: &Connection, id: &str, turn: &str) -> Result<bool> {
    Ok(db.prepare_cached("SELECT EXISTS(SELECT 1 FROM agent_turns WHERE agent_id=?1 AND turn_id=?2)")?
        .query_row(params![id, turn], |r| r.get(0))?)
}

/// The position of each of these Turns the Agent has.
pub fn turn_ords(db: &Connection, id: &str, turns: &[String]) -> Result<HashMap<String, usize>> {
    let mut query = db.prepare_cached("SELECT ord FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?;
    let mut ords = HashMap::new();
    for turn in turns {
        if let Some(ord) = query.query_row(params![id, turn], |r| r.get::<_, i64>(0)).optional()? {
            ords.insert(turn.clone(), count(ord)?);
        }
    }
    Ok(ords)
}

/// One Turn's rows assembled, with its position: with its payloads (exactly
/// as written), or without them (previews, noted).
fn read_turn(db: &Connection, agent: &str, key: &str, payloads: bool) -> Result<Option<(usize, Value)>> {
    let Some(row) = db.prepare_cached("SELECT turn_id, ord, items, data FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?
        .query_row(params![agent, key], turn_from_row).optional()? else {
        return Ok(None);
    };
    let items = db.prepare_cached(if payloads {
        "SELECT turn_id, item_id, ord, payloads, data, NULL FROM agent_items WHERE agent_id=?1 AND turn_id=?2"
    } else {
        "SELECT turn_id, item_id, ord, payloads, data, previews FROM agent_items WHERE agent_id=?1 AND turn_id=?2"
    })?.query_map(params![agent, key], item_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut fields: HashMap<String, Vec<(String, Parsed)>> = HashMap::new();
    if payloads {
        let mut query = db.prepare_cached("SELECT item_id, field, data FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2")?;
        for row in query.query_map(params![agent, key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Json>(2)?)))? {
            let (item, field, Json(value)) = row?;
            fields.entry(item).or_default().push((field, value));
        }
    }
    let ord = row.ord;
    #[cfg(test)]
    TURNS_READ.with(|n| n.set(n.get() + 1));
    let mut turn = assemble_turn(agent, row, items, &mut fields, payloads).map_err(|e| damaged(agent, e))?;
    if !fields.is_empty() {
        return Err(damaged(agent, anyhow::anyhow!("payload rows without an Item row")));
    }
    if payloads {
        for item in turn.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
            unspill(db, agent, key, item).map_err(|e| damaged(agent, e))?;
        }
    }
    Ok(Some((ord, turn)))
}

/// One Turn as an active Agent holds it, read without payloads: its newest
/// Items until they take `budget` bytes (at least `newest` of them), and
/// before them only those in progress or running a task; the others are
/// gaps (`GAP`). The rows past the budget are not read but for those few.
/// None if there is no such Turn.
pub fn load_turn_held(db: &Connection, agent: &str, key: &str, budget: usize, newest: usize) -> Result<Option<(usize, Value)>> {
    let _snapshot = snapshot(db)?;
    let Some(row) = db.prepare_cached("SELECT turn_id, ord, items, data FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?
        .query_row(params![agent, key], turn_from_row).optional()? else {
        return Ok(None);
    };
    let Some(count) = row.items else { return read_turn(db, agent, key, false) };
    #[cfg(test)]
    TURNS_READ.with(|n| n.set(n.get() + 1));
    let item = |r: ItemRow| -> Result<Value> {
        let mut value: Value = serde_json::from_str(&r.data).context("Workspace 记录无法读取")?;
        if r.payloads > 0 {
            preview_fields(&mut value, r.previews.as_deref(), r.payloads)
                .with_context(|| format!("Agent {agent}: Item {} of Turn {key}", r.key))?;
        }
        Ok(value)
    };
    let mut tail: Vec<(usize, Value)> = Vec::new();
    let mut bytes = 0;
    {
        let mut query = db.prepare_cached("SELECT turn_id, item_id, ord, payloads, data, previews FROM agent_items
            WHERE agent_id=?1 AND turn_id=?2 ORDER BY ord DESC")?;
        let mut rows = query.query(params![agent, key])?;
        while let Some(r) = rows.next()? {
            let r = item_from_row(r)?;
            let size = r.data.len() + r.previews.as_ref().map_or(0, String::len);
            if tail.len() >= newest && bytes + size > budget {
                break;
            }
            bytes += size;
            let ord = r.ord;
            tail.push((ord, item(r).map_err(|e| damaged(agent, e))?));
        }
    }
    tail.reverse();
    let from = tail.first().map_or(count, |(ord, _)| *ord);
    // Before them: Items in progress or running a task, and what the rail
    // reads (the user messages, the last assistant message with text).
    let mut last = Vec::new();
    for field in ["text", "_yuzunoCompletedText"] {
        last.extend(window::last_message(db, agent, key, field)?.filter(|ord| *ord < from));
    }
    let pinned: Vec<(usize, Value)> = db.prepare_cached("SELECT turn_id, item_id, ord, payloads, data, previews FROM agent_items i
        WHERE agent_id=?1 AND turn_id=?2 AND ord<?3 AND (json_extract(data,'$.status')='inProgress'
            OR json_extract(data,'$.type')='userMessage' OR ord IN (SELECT value FROM json_each(?4))
            OR EXISTS(SELECT 1 FROM agent_item_keys k WHERE k.agent_id=i.agent_id AND k.turn_id=i.turn_id
                AND k.item_id=i.item_id AND k.kind='running'))
        ORDER BY ord")?
        .query_map(params![agent, key, from as i64, serde_json::to_string(&last)?], item_from_row)?
        .map(|r| { let r = r?; let ord = r.ord; Ok((ord, item(r).map_err(|e| damaged(agent, e))?)) })
        .collect::<Result<_>>()?;
    let mut items = Vec::with_capacity(pinned.len() * 2 + tail.len() + 1);
    let mut at = 0;
    for (ord, value) in pinned.into_iter().chain(tail) {
        if ord < at || ord >= count {
            return Err(damaged(agent, anyhow::anyhow!("Turn {key} has Items out of order")));
        }
        if ord > at {
            items.push(gap(at, ord - at));
        }
        items.push(value);
        at = ord + 1;
    }
    if at != count && from != count {
        return Err(damaged(agent, anyhow::anyhow!("Turn {key} lacks its newest Items")));
    }
    if at < count {
        items.push(gap(at, count - at));
    }
    let mut turn: Value = serde_json::from_str(&row.data).map_err(|e| damaged(agent, e.into()))?;
    let members = turn.as_object_mut().context("Turn row is not an object")?;
    if members.get("items") != Some(&Value::from(count)) {
        return Err(damaged(agent, anyhow::anyhow!("Turn {key} row has another Item count")));
    }
    members.insert("items".into(), Value::Array(items));
    Ok(Some((row.ord, turn)))
}

/// One Turn of an Agent, with or without its payloads; None if the Agent
/// has no such Turn.
pub fn load_turn(db: &Connection, agent: &str, turn_id: &str, payloads: bool) -> Result<Option<Value>> {
    let _snapshot = snapshot(db)?;
    Ok(read_turn(db, agent, turn_id, payloads)?.map(|(_, turn)| turn))
}

/// These Turns of an Agent (those it has), in record order, each with its
/// position; with or without their payloads. One snapshot.
pub fn load_turns(db: &Connection, agent: &str, turns: &[String], payloads: bool) -> Result<Vec<(usize, Value)>> {
    let _snapshot = snapshot(db)?;
    let mut found = Vec::with_capacity(turns.len());
    let mut seen = HashSet::new();
    for turn in turns {
        if !seen.insert(turn.as_str()) {
            continue;
        }
        if let Some(read) = read_turn(db, agent, turn, payloads)? {
            found.push(read);
        }
    }
    found.sort_by_key(|(ord, _)| *ord);
    Ok(found)
}

/// Every Turn of an Agent, oldest first, read and handed to `each` one at a
/// time (only one Turn's rows are held), until `each` says to stop. For the
/// few reads that need a whole history; nothing keeps what it reads.
pub fn scan(db: &Connection, agent: &str, payloads: bool, mut each: impl FnMut(Value) -> Result<bool>) -> Result<()> {
    let _snapshot = snapshot(db)?;
    let keys: Vec<String> = db.prepare_cached("SELECT turn_id FROM agent_turns WHERE agent_id=?1 ORDER BY ord")?
        .query_map([agent], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
    for key in keys {
        let Some((_, turn)) = read_turn(db, agent, &key, payloads)? else { continue };
        if !each(turn)? {
            break;
        }
    }
    Ok(())
}

/// Whether an Agent's rows fit together as far as SQL tells without parsing
/// them: Turn and Item positions, Item counts, payload counts, and no row
/// without its Turn or Item. A few index scans, no JSON; rows whose data does
/// not parse are found only by assembling them.
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
    let Some(turn_id) = turn_id else {
        return match newest_item(db, agent, item_id)? {
            Some((turn, item)) => {
                let (turn, row) = load_one(db, agent, &turn, &item, payloads)?;
                Ok(Some(alone(turn, row)))
            }
            None => Ok(None),
        };
    };
    if !has_turn(db, agent, turn_id)? {
        return Ok(None);
    }
    if let Some(item) = item_key(db, agent, turn_id, item_id)? {
        let (turn, row) = load_one(db, agent, turn_id, &item, payloads)?;
        return Ok(Some(alone(turn, row)));
    }
    let data: String = db.prepare_cached("SELECT data FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?
        .query_row(params![agent, turn_id], |r| r.get(0))?;
    let mut turn: Value = serde_json::from_str(&data).map_err(|e| damaged(agent, e.into()))?;
    if let Some(members) = turn.as_object_mut() {
        members.insert("items".into(), Value::Array(Vec::new()));
    }
    Ok(Some(turn))
}

/// One Item of a Turn as an active Agent holds it: with its payloads, a
/// spilled field still its end and noted (`SPILLED`), its chunks left in
/// their rows. None if the Turn has no such Item.
pub fn load_held_item(db: &Connection, agent: &str, turn: &str, item_id: &str) -> Result<Option<Value>> {
    let _snapshot = snapshot(db)?;
    let Some(key) = item_key(db, agent, turn, item_id)? else { return Ok(None) };
    Ok(Some(load_one_as(db, agent, turn, &key, true, false)?.1))
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

/// The Turn holding the newest Item with this ID, if any.
pub fn item_turn(db: &Connection, agent: &str, item_id: &str) -> Result<Option<String>> {
    Ok(newest_item(db, agent, item_id)?.map(|(turn, _)| turn))
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
    load_one_as(db, agent, turn, item, payloads, payloads)
}

/// `load_one`, putting a spilled field's chunks back (`unspill`) or not.
fn load_one_as(db: &Connection, agent: &str, turn: &str, item: &str, payloads: bool, chunks: bool) -> Result<(Value, Value)> {
    let data: String = db.prepare_cached("SELECT data FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?
        .query_row(params![agent, turn], |r| r.get(0))?;
    let row = db.prepare_cached(if payloads {
        "SELECT turn_id, item_id, ord, payloads, data, NULL FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3"
    } else {
        "SELECT turn_id, item_id, ord, payloads, data, previews FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3"
    })?.query_row(params![agent, turn, item], item_from_row)?;
    let found = if payloads && row.payloads > 0 {
        db.prepare_cached("SELECT field, data FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
            .query_map(params![agent, turn, item], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Json>(1)?.0)))?
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
        if chunks {
            unspill(db, agent, turn, &mut value)?;
        }
        Ok((turn_value, value))
    })().map_err(|e| damaged(agent, e))
}

/// The Items with this key (see `index_keys`), newest Turn first: their Turn
/// and Item IDs.
pub fn keyed(db: &Connection, agent: &str, kind: &str, key: &str) -> Result<Vec<(String, String)>> {
    Ok(db.prepare_cached("SELECT k.turn_id, k.item_id FROM agent_item_keys k
        JOIN agent_turns t ON t.agent_id=k.agent_id AND t.turn_id=k.turn_id
        WHERE k.agent_id=?1 AND k.kind=?2 AND k.key=?3 ORDER BY t.ord DESC")?
        .query_map(params![agent, kind, key], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?)
}

/// The Turns of every Item with a key of this kind, each once, newest first.
pub fn keyed_turns(db: &Connection, agent: &str, kind: &str) -> Result<Vec<String>> {
    Ok(db.prepare_cached("SELECT k.turn_id FROM agent_item_keys k
        JOIN agent_turns t ON t.agent_id=k.agent_id AND t.turn_id=k.turn_id
        WHERE k.agent_id=?1 AND k.kind=?2 GROUP BY k.turn_id ORDER BY MAX(t.ord) DESC")?
        .query_map(params![agent, kind], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

/// Every key of this kind, oldest Turn first (Codex child threads, say).
pub fn keys_of(db: &Connection, agent: &str, kind: &str) -> Result<Vec<String>> {
    Ok(db.prepare_cached("SELECT k.key FROM agent_item_keys k
        JOIN agent_turns t ON t.agent_id=k.agent_id AND t.turn_id=k.turn_id
        JOIN agent_items i ON i.agent_id=k.agent_id AND i.turn_id=k.turn_id AND i.item_id=k.item_id
        WHERE k.agent_id=?1 AND k.kind=?2 ORDER BY t.ord, i.ord")?
        .query_map(params![agent, kind], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?)
}

fn receipts_from(rows: impl Iterator<Item = rusqlite::Result<String>>, agent: &str) -> Result<Vec<MessageReceipt>> {
    rows.map(|row| serde_json::from_str(&row?).map_err(|e| damaged(agent, e.into()))).collect()
}

/// The Agent's receipts not yet settled, in the order they were made.
pub fn open_receipts(db: &Connection, agent: &str) -> Result<Vec<MessageReceipt>> {
    let mut query = db.prepare_cached("SELECT data FROM agent_receipts INDEXED BY agent_receipts_open
        WHERE agent_id=?1 AND settled=0 ORDER BY ord")?;
    let rows = query.query_map([agent], |r| r.get(0))?;
    receipts_from(rows, agent)
}

/// How many of the Agent's receipts are not settled, and whether one is
/// being sent or of uncertain delivery: what deciding whether it is idle
/// needs, without reading them.
pub fn unsettled(db: &Connection, agent: &str) -> Result<(usize, bool, bool)> {
    Ok(db.prepare_cached("SELECT COUNT(*), COALESCE(MAX(json_extract(data,'$.status')='sending'),0),
        COALESCE(MAX(json_extract(data,'$.status')='uncertain'),0)
        FROM agent_receipts INDEXED BY agent_receipts_open WHERE agent_id=?1 AND settled=0")?
        .query_row([agent], |r| Ok((count(r.get(0)?)?, r.get::<_, bool>(1)?, r.get::<_, bool>(2)?)))?)
}

/// An Item's stored position in its Turn, by its key.
pub fn item_ord(db: &Connection, agent: &str, turn: &str, item: &str) -> Result<Option<usize>> {
    Ok(db.prepare_cached("SELECT ord FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
        .query_row(params![agent, turn, item], |r| count(r.get(0)?)).optional()?)
}

/// The receipts not settled and those kept with these Turns, in the order
/// they were made.
pub fn slice_receipts(db: &Connection, agent: &str, turns: &[String]) -> Result<Vec<MessageReceipt>> {
    let mut sql = String::from("SELECT data FROM agent_receipts WHERE agent_id=?1 AND (settled=0");
    if !turns.is_empty() {
        sql.push_str(" OR turn_id IN (");
        sql.push_str(&vec!["?"; turns.len()].join(","));
        sql.push(')');
    }
    sql.push_str(") ORDER BY ord");
    let mut query = db.prepare(&sql)?;
    let params: Vec<&dyn rusqlite::ToSql> = std::iter::once(&agent as &dyn rusqlite::ToSql)
        .chain(turns.iter().map(|t| t as &dyn rusqlite::ToSql)).collect();
    let rows = query.query_map(params.as_slice(), |r| r.get(0))?;
    receipts_from(rows, agent)
}

/// The settled receipts kept with these Turns, in the order they were made.
pub fn turn_receipts(db: &Connection, agent: &str, turns: &[String]) -> Result<Vec<MessageReceipt>> {
    let mut query = db.prepare_cached("SELECT ord, data FROM agent_receipts WHERE agent_id=?1 AND turn_id=?2 AND settled=1")?;
    let mut found: Vec<(i64, String)> = Vec::new();
    for turn in turns {
        for row in query.query_map(params![agent, turn], |r| Ok((r.get(0)?, r.get(1)?)))? {
            found.push(row?);
        }
    }
    found.sort_by_key(|(ord, _)| *ord);
    receipts_from(found.into_iter().map(|(_, data)| Ok(data)), agent)
}

/// The receipt of the message with this client ID, settled or not.
pub fn receipt(db: &Connection, agent: &str, client: &str) -> Result<Option<MessageReceipt>> {
    db.prepare_cached("SELECT data FROM agent_receipts WHERE agent_id=?1 AND client_id=?2")?
        .query_row(params![agent, client], |r| r.get::<_, String>(0)).optional()?
        .map(|data| serde_json::from_str(&data).map_err(|e| damaged(agent, e.into()))).transpose()
}

/// Whether a receipt not rejected answers this form (`resultId`, `formId`)
/// or this native question (`turnId`, `itemId`): found by SQL over the
/// receipt rows, none of which is parsed here.
pub fn answered(db: &Connection, agent: &str, form: Option<(&str, &str)>, question: Option<(&str, &str)>) -> Result<bool> {
    let mut found = false;
    if let Some((result, form)) = form {
        found |= db.prepare_cached("SELECT EXISTS(SELECT 1 FROM agent_receipts WHERE agent_id=?1
            AND json_extract(data,'$.input.clarification.resultId')=?2 AND json_extract(data,'$.input.clarification.formId')=?3
            AND json_extract(data,'$.status')!='rejected')")?.query_row(params![agent, result, form], |r| r.get::<_, bool>(0))?;
    }
    if let Some((turn, item)) = question {
        found |= db.prepare_cached("SELECT EXISTS(SELECT 1 FROM agent_receipts WHERE agent_id=?1
            AND json_extract(data,'$.input.question.turnId')=?2 AND json_extract(data,'$.input.question.itemId')=?3
            AND json_extract(data,'$.status')!='rejected')")?.query_row(params![agent, turn, item], |r| r.get::<_, bool>(0))?;
    }
    Ok(found)
}

/// Every receipt of the Agent, oldest first (for deleting its images; one
/// row at a time is parsed).
pub fn each_receipt(db: &Connection, agent: &str, mut each: impl FnMut(MessageReceipt)) -> Result<()> {
    let mut query = db.prepare_cached("SELECT data FROM agent_receipts WHERE agent_id=?1 ORDER BY ord")?;
    for row in query.query_map([agent], |r| r.get::<_, String>(0))? {
        each(serde_json::from_str(&row?).map_err(|e| damaged(agent, e.into()))?);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Writing

/// What one Agent write changed. Rows rewritten with what they already held
/// are not counted (the database skips them).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Written {
    /// Whether `agents.data` changed.
    pub meta: bool,
    pub turns: usize,
    pub items: usize,
    pub payloads: usize,
    pub receipts: usize,
    /// Rows deleted directly (their Items and payloads go with them).
    pub deleted: usize,
}

/// What changed in the Turns of a write since they were read: Turns and
/// Items by ID, or all of them. The metadata is always written.
///
/// It only needs to name what changed in place. A write also compares the
/// Turns it is given with their rows (new, removed) and the Items of every
/// Turn it writes with their rows, so added, removed and moved Items are
/// written even if not named.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Dirty {
    all: bool,
    /// Every Turn row given (not their Items), e.g. after a compaction.
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
    /// Everything given: snapshots, reconciliation, and changes whose
    /// extent is unknown.
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
    /// event alone.
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

    /// What changed between two states of the same Turns, by comparing
    /// them. Unchanged Turns and Items compare equal without being
    /// serialized. Turns only in `after` are new (written whole); Turns only
    /// in `before` were removed (the write finds those itself).
    pub fn between(before: &[Value], after: &[Value]) -> Self {
        let mut dirty = Self::default();
        let old: HashMap<&str, &Value> = before.iter().filter_map(|t| Some((t["id"].as_str()?, t))).collect();
        for turn in after {
            let Some(id) = turn["id"].as_str() else {
                return Self::all();
            };
            match old.get(id) {
                Some(previous) => dirty.turn_between(id, previous, turn),
                None => {
                    dirty.whole_turn(id);
                }
            }
        }
        dirty
    }

    /// What changed in Turn `id`, `previous` before and `turn` after, as
    /// `between` finds it: nothing where they are the same, else the Turn's
    /// row and its Items that changed, or all its Items where they cannot be
    /// told apart by ID.
    pub fn turn_between(&mut self, id: &str, previous: &Value, turn: &Value) {
        if previous == turn {
            return;
        }
        self.turn(id);
        let (Some(was), Some(now)) = (split_items(previous), split_items(turn)) else {
            self.whole_turn(id);
            return;
        };
        let Some(was) = by_id(was) else {
            self.whole_turn(id);
            return;
        };
        for item in now {
            match item["id"].as_str() {
                Some(item_id) if was.get(item_id) == Some(&item) => {}
                Some(item_id) => {
                    self.item(id, item_id);
                }
                None => {
                    self.whole_turn(id);
                    break;
                }
            }
        }
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
    body: MetaBody,
    ops: Vec<Op>,
}

/// One statement of a write, in order. Deleting a Turn or an Item deletes
/// its Items, keys and payloads first, so nothing depends on foreign keys.
enum Op {
    /// A Turn row; a new Turn has its position, a Turn kept keeps its own.
    Turn { key: String, ord: Option<usize>, items: Option<usize>, data: String },
    DeleteTurn { key: String },
    /// Positions 0..n again after Turns were deleted.
    Renumber,
    /// The Turns of a change, in its order, in the places they hold among
    /// all of the Agent's Turns (after its new ones were added): for a
    /// change that adds a Turn before ones stored, as a rewind's earlier
    /// page does.
    Order { keys: Vec<String> },
    /// All Item rows of a Turn now stored whole.
    DeleteItems { turn: String },
    Item { turn: String, key: String, ord: usize, payloads: usize, data: String, previews: Option<String>,
        keys: Vec<(&'static str, String)> },
    ItemOrd { turn: String, key: String, ord: usize },
    /// The Item rows of gaps moved: (stored position, count, new position).
    Shift { turn: String, ranges: Vec<(usize, usize, usize)> },
    DeleteItem { turn: String, key: String },
    /// The chunk rows of an Item's fields it no longer notes as spilled.
    DropChunks { turn: String, key: String, keep: Vec<String> },
    Payload { turn: String, item: String, field: String, data: String },
    DeletePayload { turn: String, item: String, field: String },
    Receipt(ReceiptRow),
}

/// Prepares writing a change to an Agent: its metadata (`meta`, whose Turns
/// and receipts are not read), the Turns given (`turns`, in record order:
/// those it has keep their place, new ones go after its newest), and the
/// receipts given. `loaded` names the Turns the change was given: one of them
/// missing from `turns` was removed and is deleted; a Turn neither names is
/// left as it is. `dirty` names what changed in the Turns that are kept
/// (see `Dirty`). Reads how the rows stand (the caller makes sure nothing
/// else changes them until `apply`; a reader will do) and serializes what
/// changes, so the writer is needed only for `apply`.
pub fn plan(db: &Connection, id: &str, meta: &AgentDetail, turns: &[Value], loaded: &[String], dirty: &Dirty,
    receipts: &[&MessageReceipt]) -> Result<Plan> {
    ensure!(meta.agent.id == id, "record of Agent {} written as {id}", meta.agent.id);
    let mut ops = Vec::new();
    let mut present = HashSet::new();
    for turn in turns {
        let key = turn_key(turn)?;
        ensure!(present.insert(key), "Turn {} appears twice", turn["id"]);
    }
    let mut stored: HashMap<String, Option<usize>> = HashMap::new();
    {
        let mut query = db.prepare_cached("SELECT items FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?;
        for key in present.iter().chain(loaded.iter()) {
            if let Some(items) = query.query_row(params![id, key], |r| r.get::<_, Option<i64>>(0)).optional()? {
                stored.insert(key.clone(), items.map(count).transpose()?);
            }
        }
    }
    let mut deleted = 0;
    for key in loaded {
        if !present.contains(key) && stored.contains_key(key) {
            ops.push(Op::DeleteTurn { key: key.clone() });
            deleted += 1;
        }
    }
    if deleted > 0 {
        ops.push(Op::Renumber);
    }
    let mut next = turn_count(db, id)? - deleted;
    // New Turns go after the newest; one before a Turn already stored needs
    // the change's order kept (`Op::Order`).
    let (mut keys, mut new_seen, mut new_before_stored) = (Vec::new(), false, false);
    for turn in turns {
        let key = turn_key(turn)?;
        let items = split_items(turn);
        let old = stored.get(&key).copied();
        match old {
            None => new_seen = true,
            Some(_) => new_before_stored |= new_seen,
        }
        keys.push(key.clone());
        let touched = dirty.turns.get(&key);
        let full = dirty.all || old.is_none() || touched.is_some_and(|t| t.all_items);
        let recounted = old.is_some_and(|n| n != items.map(|items| item_count(items)));
        if full || dirty.turn_rows || touched.is_some() || recounted {
            let (data, count) = turn_row(turn)?;
            let ord = old.is_none().then(|| {
                next += 1;
                next - 1
            });
            ops.push(Op::Turn { key: key.clone(), ord, items: count, data });
        }
        match items {
            None => {
                if old.is_some_and(|n| n.is_some()) {
                    ops.push(Op::DeleteItems { turn: key.clone() });
                }
            }
            Some(items) if full || recounted || touched.is_some() => {
                let named = touched.map(|t| &t.items);
                plan_items(db, id, &key, items, full, named, old.is_some(), &mut ops)?;
            }
            Some(_) => {}
        }
    }
    if new_before_stored {
        ops.push(Op::Order { keys });
    }
    for receipt in receipts {
        ops.push(Op::Receipt(receipt_row(receipt)?));
    }
    Ok(Plan { body: MetaBody::of(meta)?, ops })
}

/// Plans the Items of one Turn: all of them, or those named, new or moved;
/// and deleting the rows of Items it no longer has. A gap's rows are kept
/// (moved with it); an Item outside the gaps that a gap's rows hold is
/// refused (`GapConflict`). Only the rows outside the gaps are read.
#[allow(clippy::too_many_arguments)]
fn plan_items(db: &Connection, agent: &str, turn: &str, items: &[Value], all: bool,
    named: Option<&HashSet<String>>, existed: bool, ops: &mut Vec<Op>) -> Result<()> {
    let keys = item_keys(items);
    let gaps: Vec<(usize, usize)> = items.iter().filter_map(gap_of).collect();
    let stored: HashMap<String, usize> = if existed {
        let mut sql = String::from("SELECT item_id, ord FROM agent_items WHERE agent_id=?1 AND turn_id=?2");
        for (from, count) in &gaps {
            sql.push_str(&format!(" AND NOT (ord >= {from} AND ord < {})", from + count));
        }
        db.prepare_cached(&sql)?
            .query_map(params![agent, turn], |r| Ok((r.get::<_, String>(0)?, count(r.get(1)?)?)))?
            .collect::<rusqlite::Result<_>>()?
    } else {
        HashMap::new()
    };
    let present: HashSet<&str> = items.iter().zip(&keys).filter(|(item, _)| gap_of(item).is_none())
        .map(|(_, key)| key.as_str()).collect();
    for key in stored.keys().filter(|key| !present.contains(key.as_str())) {
        ops.push(Op::DeleteItem { turn: turn.into(), key: key.clone() });
    }
    // Gaps first: their rows are found by stored position, which nothing
    // else has changed yet.
    let mut shifts = Vec::new();
    let mut at = 0;
    for item in items {
        match gap_of(item) {
            Some((from, count)) => {
                if from != at {
                    shifts.push((from, count, at));
                }
                at += count;
            }
            None => at += 1,
        }
    }
    if !shifts.is_empty() {
        ops.push(Op::Shift { turn: turn.into(), ranges: shifts });
    }
    let mut ord = 0;
    for (item, key) in items.iter().zip(&keys) {
        if let Some((_, count)) = gap_of(item) {
            ord += count;
            continue;
        }
        let here = ord;
        ord += 1;
        let old = stored.get(key);
        if old.is_none() && existed && !gaps.is_empty() {
            let elsewhere = db.prepare_cached("SELECT 1 FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                .query_row(params![agent, turn, key], |_| Ok(())).optional()?;
            if elsewhere.is_some() {
                return Err(GapConflict { turn: turn.into(), item: key.clone() }.into());
            }
        }
        let rewrite = all || old.is_none() || positional(key) || named.is_some_and(|n| n.contains(key));
        if !rewrite {
            if old.is_some_and(|o| *o != here) {
                ops.push(Op::ItemOrd { turn: turn.into(), key: key.clone(), ord: here });
            }
            continue;
        }
        #[cfg(test)]
        PLANNED_ITEMS.with(|n| n.set(n.get() + 1));
        let previews: Option<Map<String, Value>> = if old.is_some() {
            let text: Option<String> = db.prepare_cached("SELECT previews FROM agent_items WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                .query_row(params![agent, turn, key], |r| r.get(0))?;
            match text {
                Some(text) => Some(serde_json::from_str(&text).map_err(|e| damaged(agent, e.into()))?),
                None => None,
            }
        } else {
            None
        };
        let out = item_out(item, previews.as_ref())?;
        if old.is_some() {
            let fields: Vec<String> = db.prepare_cached("SELECT field FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                .query_map(params![agent, turn, key], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for field in fields.into_iter().filter(|f| !out.kept.contains(f) && !out.payloads.iter().any(|(name, _)| name == f)) {
                ops.push(Op::DeletePayload { turn: turn.into(), item: key.clone(), field });
            }
        }
        let payloads = out.payload_count();
        // The Item row first: its payload rows refer to it.
        ops.push(Op::Item { turn: turn.into(), key: key.clone(), ord: here, payloads, data: out.data, previews: out.previews, keys: out.keys });
        for (field, data) in out.payloads {
            ops.push(Op::Payload { turn: turn.into(), item: key.clone(), field, data });
        }
        if old.is_some() {
            let keep = item[SPILLED].as_object().map(|notes| notes.keys().cloned().collect()).unwrap_or_default();
            ops.push(Op::DropChunks { turn: turn.into(), key: key.clone(), keep });
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
    let mut written = Written::default();
    let changed = db.prepare_cached("UPDATE agents SET data=?1 WHERE id=?2 AND data IS NOT ?1")?
        .execute(params![plan.body.row(agent)?, id])?;
    written.meta = changed > 0;
    ensure!(written.meta || exists(db, id)?, "Agent 不存在");
    for op in &plan.ops {
        match op {
            Op::Turn { key, ord: Some(ord), items, data } => {
                written.turns += db.prepare_cached("INSERT INTO agent_turns(agent_id,turn_id,ord,items,data) VALUES(?1,?2,?3,?4,?5)")?
                    .execute(params![id, key, *ord as i64, items.map(|n| n as i64), data])?;
            }
            Op::Turn { key, ord: None, items, data } => {
                written.turns += db.prepare_cached("UPDATE agent_turns SET items=?3, data=?4 WHERE agent_id=?1 AND turn_id=?2
                    AND (items IS NOT ?3 OR data IS NOT ?4)")?
                    .execute(params![id, key, items.map(|n| n as i64), data])?;
            }
            Op::DeleteTurn { key } => written.deleted += delete_turn(db, id, key)?,
            Op::Renumber => {
                let keys: Vec<(String, i64)> = db.prepare_cached("SELECT turn_id, ord FROM agent_turns WHERE agent_id=?1 ORDER BY ord")?
                    .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
                let mut set = db.prepare_cached("UPDATE agent_turns SET ord=?3 WHERE agent_id=?1 AND turn_id=?2")?;
                for (ord, (key, was)) in keys.iter().enumerate() {
                    if *was != ord as i64 {
                        set.execute(params![id, key, ord as i64])?;
                    }
                }
            }
            Op::Order { keys } => {
                let stored: Vec<(String, i64)> = db.prepare_cached("SELECT turn_id, ord FROM agent_turns WHERE agent_id=?1 ORDER BY ord")?
                    .query_map([id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
                let at: HashMap<&str, i64> = stored.iter().map(|(key, ord)| (key.as_str(), *ord)).collect();
                let places: Vec<i64> = stored.iter().filter(|(key, _)| keys.contains(key)).map(|(_, ord)| *ord).collect();
                let mut set = db.prepare_cached("UPDATE agent_turns SET ord=?3 WHERE agent_id=?1 AND turn_id=?2")?;
                for (key, place) in keys.iter().filter(|key| at.contains_key(key.as_str())).zip(places) {
                    if at[key.as_str()] != place {
                        set.execute(params![id, key, place])?;
                    }
                }
            }
            Op::DeleteItems { turn } => {
                db.prepare_cached("DELETE FROM agent_stream_chunks WHERE agent_id=?1 AND turn_id=?2")?.execute(params![id, turn])?;
                db.prepare_cached("DELETE FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2")?.execute(params![id, turn])?;
                db.prepare_cached("DELETE FROM agent_item_keys WHERE agent_id=?1 AND turn_id=?2")?.execute(params![id, turn])?;
                written.deleted += db.prepare_cached("DELETE FROM agent_items WHERE agent_id=?1 AND turn_id=?2")?
                    .execute(params![id, turn])?;
            }
            Op::Item { turn, key, ord, payloads, data, previews, keys } => {
                written.items += db.prepare_cached("INSERT INTO agent_items(agent_id,turn_id,item_id,ord,payloads,data,previews) VALUES(?1,?2,?3,?4,?5,?6,?7)
                    ON CONFLICT(agent_id,turn_id,item_id) DO UPDATE SET ord=excluded.ord, payloads=excluded.payloads, data=excluded.data,
                    previews=excluded.previews
                    WHERE ord IS NOT excluded.ord OR payloads IS NOT excluded.payloads OR data IS NOT excluded.data
                    OR previews IS NOT excluded.previews")?
                    .execute(params![id, turn, key, *ord as i64, *payloads as i64, data, previews])?;
                write_keys(db, id, turn, key, keys)?;
            }
            Op::ItemOrd { turn, key, ord } => {
                written.items += db.prepare_cached("UPDATE agent_items SET ord=?4 WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                    .execute(params![id, turn, key, *ord as i64])?;
            }
            Op::Shift { turn, ranges } => {
                // Through negative positions, which no row has, so ranges
                // moved past each other never mix.
                let mut away = db.prepare_cached("UPDATE agent_items SET ord=-1-(ord+?5-?3)
                    WHERE agent_id=?1 AND turn_id=?2 AND ord>=?3 AND ord<?3+?4")?;
                for (from, count, to) in ranges {
                    written.items += away.execute(params![id, turn, *from as i64, *count as i64, *to as i64])?;
                }
                db.prepare_cached("UPDATE agent_items SET ord=-1-ord WHERE agent_id=?1 AND turn_id=?2 AND ord<0")?
                    .execute(params![id, turn])?;
            }
            Op::DropChunks { turn, key, keep } => {
                let mut drop = db.prepare_cached("SELECT DISTINCT field FROM agent_stream_chunks WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?;
                let fields: Vec<String> = drop.query_map(params![id, turn, key], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
                for field in fields.into_iter().filter(|f| !keep.contains(f)) {
                    written.deleted += db.prepare_cached("DELETE FROM agent_stream_chunks WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3 AND field=?4")?
                        .execute(params![id, turn, key, field])?;
                }
            }
            Op::DeleteItem { turn, key } => {
                db.prepare_cached("DELETE FROM agent_stream_chunks WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                    .execute(params![id, turn, key])?;
                db.prepare_cached("DELETE FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
                    .execute(params![id, turn, key])?;
                db.prepare_cached("DELETE FROM agent_item_keys WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
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
            Op::Receipt(row) => written.receipts += write_receipt(db, id, row)?,
        }
    }
    Ok(written)
}

/// An Item's keys as `index_keys` gives them, replacing those it had.
fn write_keys(db: &Connection, agent: &str, turn: &str, item: &str, keys: &[(&'static str, String)]) -> Result<()> {
    let stored: Vec<(String, String)> = db.prepare_cached("SELECT kind, key FROM agent_item_keys WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?
        .query_map(params![agent, turn, item], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<_>>()?;
    let mut stored_sorted = stored.clone();
    stored_sorted.sort();
    let mut wanted: Vec<(String, String)> = keys.iter().map(|(kind, key)| ((*kind).to_owned(), key.clone())).collect();
    wanted.sort();
    if stored_sorted == wanted {
        return Ok(());
    }
    db.prepare_cached("DELETE FROM agent_item_keys WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3")?.execute(params![agent, turn, item])?;
    let mut insert = db.prepare_cached("INSERT INTO agent_item_keys(agent_id,turn_id,item_id,kind,key) VALUES(?1,?2,?3,?4,?5)")?;
    for (kind, key) in wanted {
        insert.execute(params![agent, turn, item, kind, key])?;
    }
    Ok(())
}

/// A receipt row: a new one goes after the Agent's newest.
fn write_receipt(db: &Connection, agent: &str, row: &ReceiptRow) -> Result<usize> {
    Ok(db.prepare_cached("INSERT INTO agent_receipts(agent_id,client_id,ord,settled,turn_id,data)
        VALUES(?1,?2,(SELECT COALESCE(MAX(ord),-1)+1 FROM agent_receipts WHERE agent_id=?1),?3,?4,?5)
        ON CONFLICT(agent_id,client_id) DO UPDATE SET settled=excluded.settled, turn_id=excluded.turn_id, data=excluded.data
        WHERE settled IS NOT excluded.settled OR turn_id IS NOT excluded.turn_id OR data IS NOT excluded.data")?
        .execute(params![agent, row.client, row.settled, row.turn, row.data])?)
}

/// Writes only the metadata of an Agent (`MetaBody` of a record whose Turns
/// are not needed, with its `agent` as it is now), in the caller's
/// transaction. Returns whether it changed.
pub fn write_meta(db: &Connection, id: &str, meta: &MetaBody, agent: &crate::model::Agent) -> Result<bool> {
    ensure!(!db.is_autocommit(), "Agent records are written inside a transaction");
    ensure!(agent.id == id, "record of Agent {} written as {id}", agent.id);
    Ok(db.prepare_cached("UPDATE agents SET data=?1 WHERE id=?2 AND data IS NOT ?1")?
        .execute(params![meta.row(agent)?, id])? > 0)
}

/// Writes these receipts as they are now, in the caller's transaction.
pub fn write_receipts(db: &Connection, id: &str, receipts: &[&MessageReceipt]) -> Result<usize> {
    let mut written = 0;
    for receipt in receipts {
        written += write_receipt(db, id, &receipt_row(receipt)?)?;
    }
    Ok(written)
}

/// Appends streamed fields' starts (`Chunk`) to their Items' chunk rows, in
/// the caller's transaction, after the Items' rows are written.
pub fn write_chunks<'a>(db: &Connection, agent: &str, chunks: impl IntoIterator<Item = &'a Chunk>) -> Result<()> {
    let mut insert = db.prepare_cached("INSERT INTO agent_stream_chunks(agent_id,turn_id,item_id,field,seq,data)
        VALUES(?1,?2,?3,?4,(SELECT COALESCE(MAX(seq),-1)+1 FROM agent_stream_chunks
            WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3 AND field=?4),?5)")?;
    for chunk in chunks {
        insert.execute(params![agent, chunk.turn, chunk.item, chunk.field, chunk.data])?;
    }
    Ok(())
}

/// Whether `start` is a field's chunk rows followed by `pending` (chunks not
/// written yet), in order: the start of the text that streamed into it.
/// Compared a chunk at a time; no chunk is copied.
pub fn chunks_are(db: &Connection, agent: &str, turn: &str, item: &str, field: &str, start: &str, pending: &[String]) -> Result<bool> {
    let mut query = db.prepare_cached("SELECT data FROM agent_stream_chunks WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3
        AND field=?4 ORDER BY seq")?;
    let mut rows = query.query(params![agent, turn, item, field])?;
    let mut at = 0;
    let mut next = |chunk: &str| {
        let end = at + chunk.len();
        let same = start.get(at..end) == Some(chunk);
        at = end;
        same
    };
    while let Some(row) = rows.next()? {
        if !next(row.get_ref(0)?.as_str()?) {
            return Ok(false);
        }
    }
    for chunk in pending {
        if !next(chunk) {
            return Ok(false);
        }
    }
    Ok(at == start.len())
}

/// Deletes a field's chunk rows: an event replaced the field whole.
pub fn drop_chunks(db: &Connection, agent: &str, turn: &str, item: &str, field: &str) -> Result<()> {
    db.prepare_cached("DELETE FROM agent_stream_chunks WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3 AND field=?4")?
        .execute(params![agent, turn, item, field])?;
    Ok(())
}

/// An Item read with its payloads made whole: each field it notes as
/// spilled is its chunks followed by its value, and the note goes.
fn unspill(db: &Connection, agent: &str, turn: &str, item: &mut Value) -> Result<()> {
    unspill_with(db, agent, turn, item, &[])
}

/// `unspill` of an Item whose streamed start may still be partly in memory:
/// each field is its chunk rows, then its `pending` chunks (those not
/// written yet, in order), then its value.
pub fn unspill_with(db: &Connection, agent: &str, turn: &str, item: &mut Value, pending: &[Chunk]) -> Result<()> {
    let Some(notes) = item.as_object_mut().and_then(|members| members.remove(SPILLED)) else { return Ok(()) };
    let key = item["id"].as_str().context("a spilled Item has no ID")?.to_owned();
    let mut query = db.prepare_cached("SELECT data FROM agent_stream_chunks WHERE agent_id=?1 AND turn_id=?2 AND item_id=?3
        AND field=?4 ORDER BY seq")?;
    for (field, note) in notes.as_object().into_iter().flatten() {
        let mut whole = String::with_capacity(note["bytes"].as_u64().unwrap_or(0) as usize);
        for chunk in query.query_map(params![agent, turn, key, field], |r| r.get::<_, String>(0))? {
            whole.push_str(&chunk?);
        }
        for chunk in pending.iter().filter(|c| c.turn == turn && c.item == key && c.field == *field) {
            whole.push_str(&chunk.data);
        }
        ensure!(whole.len() as u64 == note["bytes"].as_u64().unwrap_or(u64::MAX), "Item {key}: chunks of {field} do not add up");
        whole.push_str(item[field.as_str()].as_str().unwrap_or_default());
        item[field.as_str()] = Value::String(whole);
    }
    Ok(())
}

/// Deletes one Turn's rows, its Items', keys' and payloads' first (so this
/// does not depend on foreign keys being enforced). Returns the Turn rows
/// deleted.
fn delete_turn(db: &Connection, agent: &str, turn: &str) -> Result<usize> {
    db.prepare_cached("DELETE FROM agent_stream_chunks WHERE agent_id=?1 AND turn_id=?2")?.execute(params![agent, turn])?;
    db.prepare_cached("DELETE FROM agent_payloads WHERE agent_id=?1 AND turn_id=?2")?.execute(params![agent, turn])?;
    db.prepare_cached("DELETE FROM agent_item_keys WHERE agent_id=?1 AND turn_id=?2")?.execute(params![agent, turn])?;
    db.prepare_cached("DELETE FROM agent_items WHERE agent_id=?1 AND turn_id=?2")?.execute(params![agent, turn])?;
    Ok(db.prepare_cached("DELETE FROM agent_turns WHERE agent_id=?1 AND turn_id=?2")?.execute(params![agent, turn])?)
}

/// Deletes all of an Agent's rows but its `agents` row, in the caller's
/// transaction.
pub fn delete_rows(db: &Connection, agent: &str) -> Result<()> {
    db.prepare_cached("DELETE FROM agent_stream_chunks WHERE agent_id=?1")?.execute([agent])?;
    db.prepare_cached("DELETE FROM agent_payloads WHERE agent_id=?1")?.execute([agent])?;
    db.prepare_cached("DELETE FROM agent_item_keys WHERE agent_id=?1")?.execute([agent])?;
    db.prepare_cached("DELETE FROM agent_items WHERE agent_id=?1")?.execute([agent])?;
    db.prepare_cached("DELETE FROM agent_turns WHERE agent_id=?1")?.execute([agent])?;
    db.prepare_cached("DELETE FROM agent_receipts WHERE agent_id=?1")?.execute([agent])?;
    Ok(())
}

/// Adds a new Agent, in the caller's transaction, from its `split` (made
/// before the writer is taken).
pub fn insert(db: &Connection, id: &str, rows: &Rows) -> Result<()> {
    ensure!(!db.is_autocommit(), "Agent records are written inside a transaction");
    db.execute("INSERT INTO agents(id,data) VALUES(?1,?2)", params![id, rows.meta])?;
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
    let mut keys = db.prepare_cached("INSERT INTO agent_item_keys(agent_id,turn_id,item_id,kind,key) VALUES(?1,?2,?3,?4,?5)")?;
    for key in &rows.keys {
        keys.execute(params![id, key.turn, key.item, key.kind, key.key])?;
    }
    for receipt in &rows.receipts {
        write_receipt(db, id, receipt)?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "record_rows_tests.rs"]
mod tests;
