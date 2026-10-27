//! The session store (T-140): Agents' records, kept as rows
//! (`record_rows`), and what Core holds of them in memory.
//!
//! Rows are the only copy of a history. In memory Core keeps, for each
//! Agent with activity (at most MAX_STREAMS of them), its metadata and its
//! open and newest Turns (`Hot`), Items that ended in the form they are read
//! without payloads (each large field its preview). Every read and change
//! names the Turns it needs (`Sel`); nothing loads, copies, compares or
//! serializes a whole history. A native event is applied to the hot Turns
//! and written, with its journal row, at once; streamed output (deltas) stays
//! in memory until the stream tick or the next write, and a reader writes it
//! first, so what readers see is always the rows.
use crate::model::{now, Agent, AgentDetail, MessageReceipt, PendingRequest};
use crate::record_rows::{self, Damaged, Dirty};
use crate::remote::RemoteMachine;
use anyhow::{bail, ensure, Context, Result};
use chrono::{DateTime, Utc};
use parking_lot::RwLock;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// How long streamed output (deltas) may stay only in memory before its
/// Items are written. Every journaled change is written at once; this only
/// bounds how much partial text a crash may lose (completed content never).
pub const STREAM_WRITE_AFTER: Duration = Duration::from_secs(10);
/// An active Agent nothing has reached for this long is dropped from memory.
const STREAM_IDLE: Duration = Duration::from_secs(5);
/// At most this many Agents are kept in memory at once.
pub const MAX_STREAMS: usize = 8;
/// The most of a streamed field an active Agent holds in memory: past it,
/// all but its last STREAM_KEEP bytes are written at once as chunk rows
/// (`record_rows::SPILLED`), which every read with payloads puts back. Each
/// such write moves at least STREAM_HOLD - STREAM_KEEP bytes, so a fast
/// stream is written about once per MiB.
pub const STREAM_HOLD: usize = 1 << 20;
const STREAM_KEEP: usize = 64 << 10;
/// An active Agent's Items in progress together: past this, each of their
/// streamed fields is written down to its last STREAM_MIN bytes.
pub const IN_PROGRESS_HOLD: usize = 2 << 20;
const STREAM_MIN: usize = 4 << 10;
/// The ended Items an active Agent holds in memory (`client_view::size_of`):
/// past this, the oldest are left to their rows (a gap, `record_rows::GAP`)
/// and an event naming one reads it back.
pub const HOT_ITEMS: usize = 1 << 20;
/// The newest entries of each Turn in memory never go to a gap.
const NEWEST_KEEP: usize = 4;

/// How a native event reaches its Agent's record. Decided once per event by
/// `route` and passed through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// Journaled and written with its record at once by its caller (Turn
    /// boundaries, request resolution, errors, status, compaction, the
    /// session's start and its reported mode, MCP server connection status).
    Synchronous,
    /// Journaled and applied to the Agent's hot Turns, and written with its
    /// journal row at once: completed content (Codex Items starting and
    /// finishing, Claude assistant messages, tool results and sub-agent task
    /// events), plan and token usage, Claude rate limits, and any future kind
    /// `apply` or `project_event` acts on.
    Deferred,
    /// Streaming output: applied to the hot Turns and announced, never
    /// journaled; written by the stream tick, the next write or a reader, and
    /// a field's start at once past STREAM_HOLD. The completed form of the
    /// same content is journaled and replaces it. After a crash an Item still
    /// streaming may lose its last unwritten text, completed content never.
    Ephemeral,
    /// Journaled as native evidence only, because nothing in the record
    /// changes for it (`AgentDetail::acts_on`, `claude::acts_on`).
    Evidence,
    /// Streaming output nothing in the record changes for: dropped.
    Ignored,
}

/// The route of one native event (Codex method and params, or `claude/` and
/// the SDK event type with the whole bridge message).
pub fn route(kind: &str, data: &Value) -> Route {
    if synchronous(kind, data) {
        return Route::Synchronous;
    }
    let changes = match kind.strip_prefix("claude/") {
        Some(_) => crate::claude::acts_on(&data["event"]),
        None => AgentDetail::acts_on(kind),
    };
    match (streaming(kind, data), changes) {
        (true, true) => Route::Ephemeral,
        (true, false) => Route::Ignored,
        (false, true) => Route::Deferred,
        (false, false) => Route::Evidence,
    }
}

fn synchronous(kind: &str, data: &Value) -> bool {
    match kind.strip_prefix("claude/") {
        Some("result") => true,
        Some("system") => {
            let event = &data["event"];
            matches!(event["subtype"].as_str(), Some("init" | "compact_boundary")) || event.get("permissionMode").is_some()
        }
        Some(_) => false,
        None => (kind.starts_with("turn/") && !matches!(kind, "turn/plan/updated" | "turn/diff/updated"))
            || kind.starts_with("serverRequest/")
            || kind.starts_with("mcpServer/")
            || matches!(kind, "error" | "thread/started" | "thread/status/changed" | "thread/compacted"),
    }
}

/// Output that grows while it is generated and that a completed event
/// supersedes (or, for the Turn diff and thinking counts, the next one).
fn streaming(kind: &str, data: &Value) -> bool {
    match kind.strip_prefix("claude/") {
        Some("stream_event") => true,
        Some("system") => data["event"]["subtype"] == "thinking_tokens",
        Some(_) => false,
        None => kind.ends_with("/delta")
            || kind.ends_with("Delta")
            || matches!(kind, "item/reasoning/summaryPartAdded" | "turn/diff/updated"),
    }
}

/// The Items an event's change reaches, for `changed_items_since`.
fn touched_items(kind: &str, data: &Value, mut touch: impl FnMut(&str)) {
    if kind.starts_with("item/") {
        if let Some(item) = data["itemId"].as_str().or_else(|| data["item"]["id"].as_str()) {
            touch(item);
        }
    }
    if matches!(kind, "turn/started" | "turn/accepted" | "turn/completed" | "turn/reconfirmed") {
        for item in data["turn"]["items"].as_array().into_iter().flatten() {
            if let Some(item) = item["id"].as_str() {
                touch(item);
            }
        }
    }
}

/// Where every streamed native event, Codex or Claude, is applied to the
/// hot Turns. `at` is the event's journal time (now, for an ephemeral one).
fn apply_streamed(detail: &mut AgentDetail, seq: Option<i64>, kind: &str, data: &Value, at: DateTime<Utc>) {
    #[cfg(test)]
    if data["_testPanic"] == true {
        // As a bug in applying an event would: after changing part of it.
        detail.agent.name.push_str(" (half-applied)");
        panic!("applying {kind} failed half-way");
    }
    if kind.starts_with("claude/") {
        crate::claude::project_event_at(detail, data["turnId"].as_str(), &data["event"], at);
    } else {
        detail.apply_at(kind, data, at);
    }
    if let Some(seq) = seq {
        detail.agent.last_seq = seq;
    }
    detail.agent.updated_at = at.to_rfc3339();
}

/// What other parts of Core act on as soon as it changes: status and error,
/// requests, Turn boundaries, unconfirmed messages, the connection and the
/// native identity. Streamed events normally leave all of it alone; one that
/// does not is announced and written at once.
#[derive(PartialEq)]
struct Watched {
    status: String,
    error: Option<String>,
    connection: String,
    closed: bool,
    session: Option<String>,
    thread: Option<String>,
    pending: usize,
    turns: Vec<String>,
    running: usize,
    unconfirmed: usize,
}

fn watched(d: &AgentDetail) -> Watched {
    Watched {
        status: d.agent.status.clone(),
        error: d.agent.error.clone(),
        connection: d.agent.connection_state.clone(),
        closed: d.agent.closed_at.is_some(),
        session: d.agent.claude_session_id.clone(),
        thread: d.agent.thread_id.clone(),
        pending: d.pending.len(),
        turns: d.turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect(),
        running: d.turns.iter().filter(|t| t["status"] == "inProgress").count(),
        unconfirmed: d.message_receipts.iter().filter(|r| !matches!(r.status.as_str(), "accepted" | "rejected")).count(),
    }
}

/// An Agent as listed, plus what collaboration needs to know about it,
/// without its Turns. Every write keeps it current, so listing Agents,
/// checking an event's owner, doorbells and MCP calls never parse records.
#[derive(Clone)]
pub(crate) struct Brief {
    /// With its rail summary; without its Project, which is per call.
    pub agent: Agent,
    /// The latest Turn still in progress.
    pub active_turn: Option<String>,
    /// That Turn is output of Claude's own it has not yet said it started
    /// (see claude::open_native_turn): whose it is is not yet known.
    pub active_turn_unmatched: bool,
    /// Native requests can be located without copying every Agent's history.
    pending_ids: Vec<String>,
    activity: Activity,
}

/// The history-independent facts needed to decide whether an Agent is idle.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Activity {
    pub pending: bool,
    pub sending: bool,
    pub uncertain: bool,
    pub running: bool,
}

impl Activity {
    /// Of a record holding at least its open Turns and unsettled receipts.
    pub(crate) fn of(detail: &AgentDetail) -> Self {
        Self::with(detail, Unsettled::of(&detail.message_receipts))
    }

    /// Of a record holding its open Turns, with what its receipts say.
    fn with(detail: &AgentDetail, receipts: Unsettled) -> Self {
        Self {
            pending: detail.pending.iter().any(|p| !p.stale),
            sending: receipts.sending,
            uncertain: receipts.uncertain,
            // An in-progress Turn without an ID still blocks an update.
            running: detail.turns.iter().any(|t| t["status"] == "inProgress"),
        }
    }
}

/// What an Agent's receipts not settled say: an active Agent keeps this,
/// not the receipts (`record_rows::unsettled`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Unsettled {
    count: usize,
    sending: bool,
    uncertain: bool,
}

impl Unsettled {
    fn of(receipts: &[MessageReceipt]) -> Self {
        let open: Vec<&MessageReceipt> = receipts.iter().filter(|r| !record_rows::settled(r)).collect();
        Self { count: open.len(), sending: open.iter().any(|r| r.status == "sending"),
            uncertain: open.iter().any(|r| r.status == "uncertain") }
    }

    fn read(db: &Connection, id: &str) -> Result<Self> {
        let (count, sending, uncertain) = record_rows::unsettled(db, id)?;
        Ok(Self { count, sending, uncertain })
    }
}

/// Of a record holding its open and newest Turns and its unsettled receipts.
fn brief(detail: &AgentDetail) -> Brief {
    brief_with(detail, Unsettled::of(&detail.message_receipts))
}

/// `brief` of an active Agent's slice, which holds no receipts.
fn brief_with(detail: &AgentDetail, receipts: Unsettled) -> Brief {
    let mut agent = detail.agent.clone();
    agent.work_summary = crate::rail::project(detail);
    agent.project_id = None;
    let active = detail.turns.iter().rev().find(|t| t["status"] == "inProgress");
    let active_turn = active.and_then(|t| t["id"].as_str()).map(str::to_owned);
    let active_turn_unmatched = active.is_some_and(|t| t["_yuzunoUnmatched"] == true);
    let pending_ids = detail.pending.iter().map(|p| p.id.clone()).collect();
    Brief { agent, active_turn, active_turn_unmatched, pending_ids, activity: Activity::with(detail, receipts) }
}

/// Which of an Agent's Turns a read or a change works on (T-140). Every
/// selection but `Meta` also holds the Agent's open Turns and its newest
/// one, so `turns.last()` is the newest Turn and whether a Turn runs is
/// known. Turns come in record order, read without payloads (each large
/// field its preview, noted): a change that keeps such a field keeps its
/// payload (`record_rows`), and `payload_view` reads one in full.
#[derive(Clone, Debug)]
pub enum Sel {
    /// No Turns: the metadata and the receipts not yet settled.
    Meta,
    /// The open Turns and the newest one.
    Open,
    /// The newest `n` Turns, and the open ones.
    Tail(usize),
    /// These Turns (those the Agent has), and the open and newest ones.
    Turns(Vec<String>),
    /// These Turns whole (those the Agent has), and the open and newest ones
    /// as an active Agent holds them (`held_turns`: their newest Items within
    /// HOT_ITEMS, Items in progress and what the rail reads, gaps between).
    /// For a snapshot merge, which reaches Items only in the Turns it names,
    /// and the checks before one: a long newest Turn is not read whole.
    Named(Vec<String>),
}

/// The part of a record outside its Turns that a change through
/// `Store::update_meta` may make: no Turn can be reached from it.
pub struct Meta<'a> {
    pub agent: &'a mut Agent,
    /// The receipts not yet settled (`record_rows::settled`); one pushed is
    /// a new receipt.
    pub message_receipts: &'a mut Vec<MessageReceipt>,
    /// Pending native requests are metadata too: a request arriving, its
    /// answer and its replay change them and the Agent's status only.
    pub pending: &'a mut Vec<PendingRequest>,
    /// What Claude's runtime reports, the effort a Turn ran at among it.
    pub claude_runtime: &'a mut Option<crate::model::ClaudeRuntime>,
    /// The context window's use, marked stale when the connection ends.
    pub context_usage: &'a mut Option<crate::model::ContextUsage>,
}

impl<'a> Meta<'a> {
    fn of(detail: &'a mut AgentDetail) -> Self {
        Self { agent: &mut detail.agent, message_receipts: &mut detail.message_receipts, pending: &mut detail.pending,
            claude_runtime: &mut detail.claude_runtime, context_usage: &mut detail.context_usage }
    }
}

/// A held record's Agent, as `Store::held_agents` lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct HeldAgent {
    pub id: String,
    /// None when its record was being changed at that moment.
    pub name: Option<String>,
    /// It has streamed output its rows lack yet.
    pub unwritten: bool,
    /// What its slice holds (`client_view::size_of`); None as for `name`.
    pub bytes: Option<usize>,
}

/// What Core keeps in memory of an Agent with activity: its metadata (with
/// its receipts not yet settled) and its open and newest Turns, Items that
/// ended in their form without payloads. The slice has its own lock, so a
/// reader of it never holds `Store::memory`.
struct Hot {
    slice: Arc<RwLock<AgentDetail>>,
    /// Streamed output its rows lack: Items changed since written.
    unwritten: Dirty,
    /// Since when; None once written.
    unwritten_since: Option<Instant>,
    /// When an event or change last reached it.
    last: Instant,
    /// Streamed events only mark the brief; it is rebuilt when read.
    brief_stale: bool,
    /// Counts changes to `slice`: a brief rebuilt from it outside `memory`
    /// is kept only if no change came in meanwhile.
    changes: u64,
    /// Streamed fields' starts cut from `slice` and not yet written (a write
    /// that failed): written by the next write, before anything else.
    chunks: Vec<record_rows::Chunk>,
    /// What the Agent's receipts not settled say, as of the last write.
    unsettled: Unsettled,
}

impl Hot {
    fn new(slice: AgentDetail, unsettled: Unsettled, now: Instant) -> Self {
        Self { slice: Arc::new(RwLock::new(slice)), unwritten: Dirty::default(), unwritten_since: None, last: now,
            brief_stale: false, changes: 0, chunks: Vec::new(), unsettled }
    }
}

/// At most this many Items' last change is kept per Agent for
/// `changed_items_since`; the oldest go first.
const ITEM_EVIDENCE: usize = 256;

/// Which changes reached an Agent's record in this Core process, by rev, so
/// a native snapshot requested at some rev is not taken for newer than them.
#[derive(Default)]
struct Evidence {
    /// Rev of the last event (native or Core's own; read marks are not).
    event: u64,
    /// Items and the rev of the last change that reached each.
    items: HashMap<String, u64>,
    /// Item evidence up to this rev was dropped to stay within ITEM_EVIDENCE.
    floor: u64,
}

impl Evidence {
    fn touch(&mut self, item: &str, rev: u64) {
        if let Some(at) = self.items.get_mut(item) {
            *at = rev;
            return;
        }
        self.items.insert(item.into(), rev);
        if self.items.len() > ITEM_EVIDENCE {
            if let Some((oldest, at)) = self.items.iter().min_by_key(|(_, at)| **at).map(|(item, at)| (item.clone(), *at)) {
                self.items.remove(&oldest);
                self.floor = self.floor.max(at);
            }
        }
    }
}

/// What changed in an Agent's record after a given rev (see
/// `Store::changed_items_since`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Changes {
    /// An event changed it since (a read mark alone does not count).
    pub newer: bool,
    /// Items changes reached since.
    pub items: HashSet<String>,
    /// False if Item evidence that far back was dropped: Items still in
    /// progress may have changed too, and are best treated as newer.
    pub complete: bool,
}

/// What `Store::record_stream` did with an event.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Streamed {
    /// The change it made to the record (see `Agent::rev`); None if it
    /// changed nothing (evidence only, or dropped).
    pub rev: Option<u64>,
    /// It changed what other parts of Core act on: announce it now.
    pub urgent: bool,
}

/// What Store keeps in memory. Its lock (`Store::memory`) is held only for
/// bookkeeping: never across SQLite, a slice's (de)serialization or copy, or
/// while waiting for another lock.
struct Memory {
    hot: HashMap<String, Hot>,
    briefs: HashMap<String, Brief>,
    /// Agents with progress not announced yet.
    announce: HashSet<String>,
    /// Each Agent's row version, a sequence lock: odd while a write of its
    /// rows is being committed (`Store::rewrite`), even otherwise, and the
    /// rev of a committed change becomes visible with the even bump. A
    /// reader that saw the same even version before and after its snapshot
    /// knows the snapshot holds exactly the changes up to the rev it read
    /// with it, and that a brief built from it may be kept.
    versions: HashMap<String, u64>,
    /// The change counter of this Core process (see `Agent::rev`), and the
    /// last value each Agent's record took.
    last_rev: u64,
    revs: HashMap<String, u64>,
    evidence: HashMap<String, Evidence>,
    /// Agents whose rows were found damaged in this process: no change is
    /// made to them.
    damaged: HashSet<String>,
}

impl Memory {
    fn bump_version(&mut self, id: &str) {
        *self.versions.entry(id.into()).or_default() += 1;
    }

    fn version(&self, id: &str) -> u64 {
        self.versions.get(id).copied().unwrap_or(0)
    }

    /// A change to the Agent's record: its rev.
    fn changed(&mut self, id: &str) -> u64 {
        self.last_rev += 1;
        self.revs.insert(id.into(), self.last_rev);
        self.last_rev
    }

    /// A change an event made, native or Core's own: its rev, recorded with
    /// the Items it reached.
    fn event(&mut self, id: &str, kind: &str, data: &Value) -> u64 {
        let rev = self.changed(id);
        let evidence = self.evidence.entry(id.into()).or_default();
        evidence.event = rev;
        touched_items(kind, data, |item| evidence.touch(item, rev));
        rev
    }

    fn rev(&self, id: &str) -> u64 {
        self.revs.get(id).copied().unwrap_or(0)
    }
}

/// A write of one Agent's rows, from just before its commit until memory
/// shows it (see `Memory::versions`). Dropped without `done` (the write
/// failed and rolled back), it only makes the version even again.
struct Rewrite<'a> {
    store: &'a Store,
    id: &'a str,
    done: bool,
}

impl Rewrite<'_> {
    fn done<T>(mut self, show: impl FnOnce(&mut Memory) -> T) -> T {
        self.done = true;
        let mut memory = self.store.memory.lock().unwrap();
        memory.bump_version(self.id);
        show(&mut memory)
    }
}

impl Drop for Rewrite<'_> {
    fn drop(&mut self) {
        if !self.done {
            if let Ok(mut memory) = self.store.memory.lock() {
                memory.bump_version(self.id);
            }
        }
    }
}

#[cfg(test)]
thread_local! {
    /// Runs on this thread right after a change commits (tests pause there).
    static AFTER_COMMIT: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
    /// How many changes (`Store::change` and what calls it) committed on
    /// this thread.
    pub(crate) static CHANGES: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// What one stream tick did.
pub struct Tick {
    /// Agents with streamed events since the previous tick, to announce once
    /// rather than per event.
    pub announce: Vec<String>,
    /// Writes of streamed output that failed. Those Agents stay in memory
    /// and are tried again on the next tick.
    pub failed: Vec<anyhow::Error>,
}

/// How `Store::listed` may read a record it has to parse.
#[derive(Clone, Copy)]
enum Load<'a> {
    Reader,
    Through(&'a Connection),
    Never,
}

/// Store's locks, outermost first:
///
/// 1. An Agent's record lock (`records`): held by whatever changes that
///    Agent's rows, journal or hot slice, from reading it until memory shows
///    the commit. Changes to one Agent are serialized by it.
/// 2. At most one database connection: the writer or a reader.
/// 3. `memory`, or a hot slice's own lock, never both at once and never
///    while waiting for anything else.
pub struct Store {
    pub(crate) db: crate::db::Db,
    memory: Mutex<Memory>,
    records: Mutex<HashMap<String, Arc<parking_lot::Mutex<()>>>>,
    // Keep the OS lock alive until SQLite is closed. A second Core must not mark
    // the first Core's running agents offline merely because it uses another port.
    // It also keeps older Cores out while they would mishandle this Workspace.
    pub(crate) workspace_lock: crate::older_cores::Guard,
}

impl Drop for Store {
    fn drop(&mut self) {
        if self.memory.is_poisoned() {
            return;
        }
        // Streamed output still only in memory is written before closing.
        for error in self.flush().failed {
            eprintln!("Workspace streamed output not written on close: {error:#}");
        }
    }
}

/// Unfinished Jobs that run on a machine.
fn machine_jobs(db: &Connection, id: &str) -> Result<i64> {
    Ok(db.query_row(
        "SELECT COUNT(*) FROM local_jobs WHERE (reserved=1 OR status IN ('queued','waiting'))
         AND json_extract(data,'$.executor.machineId')=?1", [id], |r| r.get(0))?)
}

fn unread(db: &Connection, id: &str, reviewed: i64) -> Result<u64> {
    Ok(db.query_row("SELECT COUNT(*) FROM journal WHERE agent_id=?1 AND seq>?2 AND kind IN ('turn/completed','request','runtime/error')",
        params![id, reviewed], |r| r.get::<_, i64>(0))? as u64)
}

/// Whether Agent ?1's Turn ?2 has its completion journaled or came from a
/// Codex import (see `COMPLETION_INDEX`).
const COMPLETED: &str = "SELECT EXISTS(SELECT 1 FROM journal WHERE agent_id=?1 AND kind='turn/completed' AND json_extract(data,'$.turn.id')=?2)
    OR EXISTS(SELECT 1 FROM codex_import_turns WHERE agent_id=?1 AND turn_id=?2)";

/// Whether a `turn/completed` about to be journaled completes a Turn whose
/// completion is journaled already, or that came from a Codex import: then
/// it is journaled as `turn/reconfirmed`, which creates no unread result.
fn completed_before(db: &Connection, id: &str, kind: &str, data: &Value) -> Result<bool> {
    Ok(kind == "turn/completed" && db.query_row(COMPLETED, params![id, data["turn"]["id"].as_str()], |r| r.get(0))?)
}

/// The IDs `sel` names, in no order (record order comes from the rows).
fn selected(db: &Connection, id: &str, sel: &Sel) -> Result<Vec<String>> {
    let mut ids = match sel {
        Sel::Meta => return Ok(Vec::new()),
        Sel::Open => Vec::new(),
        Sel::Tail(n) => record_rows::newest_turns(db, id, *n)?,
        Sel::Turns(turns) | Sel::Named(turns) => turns.clone(),
    };
    ids.extend(record_rows::open_turns(db, id)?);
    ids.extend(record_rows::newest_turns(db, id, 1)?);
    Ok(ids)
}

/// The receipts a slice holding these Turns works with: those not settled,
/// and the settled ones kept with these Turns, in the order they were made.
fn slice_receipts(db: &Connection, id: &str, turns: &[String]) -> Result<Vec<MessageReceipt>> {
    record_rows::slice_receipts(db, id, turns)
}

/// These Turns as an active Agent holds them (`record_rows::load_turn_held`,
/// within HOT_ITEMS each), in record order, their Items in progress whole.
fn held_turns(db: &Connection, id: &str, ids: &[String]) -> Result<Vec<(usize, Value)>> {
    let mut seen = HashSet::new();
    let mut turns = Vec::new();
    for tid in ids {
        if !seen.insert(tid.as_str()) {
            continue;
        }
        if let Some((ord, mut turn)) = record_rows::load_turn_held(db, id, tid, HOT_ITEMS, NEWEST_KEEP)? {
            whole_in_progress(db, id, &mut turn)?;
            turns.push((ord, turn));
        }
    }
    turns.sort_by_key(|(ord, _)| *ord);
    Ok(turns)
}

/// The Turns `ids` in record order (`Sel::Named`): those `whole` names
/// without payloads, the others as an active Agent holds them.
fn read_named(db: &Connection, id: &str, ids: &[String], whole: &[String]) -> Result<Vec<(usize, Value)>> {
    let (named, held): (Vec<String>, Vec<String>) = ids.iter().cloned().partition(|tid| whole.contains(tid));
    let mut turns = record_rows::load_turns(db, id, &named, false)?;
    turns.extend(held_turns(db, id, &held)?);
    turns.sort_by_key(|(ord, _)| *ord);
    Ok(turns)
}

/// Puts the Items of `turn` still in progress (read without payloads) in
/// whole: streamed output appends to them, and a field's preview is not its
/// value. Each such Item is its own size, bounded in memory by `spill`.
fn whole_in_progress(db: &Connection, id: &str, turn: &mut Value) -> Result<()> {
    let Some(tid) = turn["id"].as_str().map(str::to_owned) else { return Ok(()) };
    for item in turn.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
        if ended(item) || item.get(record_rows::TRUNCATED).is_none() {
            continue;
        }
        let Some(key) = item["id"].as_str().map(str::to_owned) else { continue };
        if let Some(whole) = record_rows::load_held_item(db, id, &tid, &key)? {
            *item = whole;
        }
    }
    Ok(())
}

/// What `sel` reads of an Agent from its rows, in the caller's snapshot:
/// its metadata, the Turns selected (without payloads, in record order) and
/// their receipts. None if there is no such Agent.
fn read_slice(db: &Connection, id: &str, sel: &Sel) -> Result<Option<AgentDetail>> {
    let Some(mut detail) = record_rows::load_meta(db, id)? else { return Ok(None) };
    let ids = selected(db, id, sel)?;
    detail.turns = match sel {
        Sel::Named(whole) => read_named(db, id, &ids, whole)?,
        _ => record_rows::load_turns(db, id, &ids, false)?,
    }.into_iter().map(|(_, turn)| turn).collect();
    let turns: Vec<String> = detail.turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect();
    detail.message_receipts = slice_receipts(db, id, &turns)?;
    Ok(Some(detail))
}

/// What an active Agent keeps in memory, read from its rows: its metadata
/// and open and newest Turns, with what its receipts say (not the receipts).
fn read_hot(db: &Connection, id: &str) -> Result<(AgentDetail, Unsettled)> {
    let Some(mut detail) = record_rows::load_meta(db, id)? else { bail!("Agent 不存在") };
    let ids = selected(db, id, &Sel::Open)?;
    detail.turns = held_turns(db, id, &ids)?.into_iter().map(|(_, turn)| turn).collect();
    Ok((detail, Unsettled::read(db, id)?))
}

/// Whether an Item ended, so it is kept in memory without its payloads.
fn ended(item: &Value) -> bool {
    item["status"] != "inProgress"
}

/// Turns of `slice` that are neither in progress, the newest nor changed by
/// this write are dropped from it (the last stay until the next write, for
/// what announces it), Items that ended in the Turns `written` names lose
/// their payloads (`record_rows::compact`), past HOT_ITEMS the oldest ended
/// Items go to gaps (`evict`), and no receipt stays: what an active Agent
/// keeps. Only after a write: every Item in memory is then as written.
fn trim_hot(slice: &mut AgentDetail, written: &Dirty) {
    let newest = slice.turns.last().and_then(|t| t["id"].as_str()).map(str::to_owned);
    slice.turns.retain(|t| t["status"] == "inProgress" || t["id"].as_str() == newest.as_deref()
        || t["id"].as_str().is_some_and(|tid| written.turns().contains_key(tid)));
    for turn in &mut slice.turns {
        let Some(tid) = turn["id"].as_str().map(str::to_owned) else { continue };
        let all = written.is_all() || written.all_turn_rows();
        let Some(touched) = written.turns().get(&tid).cloned().or_else(|| all.then(Default::default)) else { continue };
        for item in turn.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
            let named = all || touched.all_items || item["id"].as_str().is_some_and(|i| touched.items.contains(i));
            if named && ended(item) {
                record_rows::compact(item);
            }
        }
    }
    evict(slice, HOT_ITEMS);
    slice.message_receipts.clear();
}

/// Whether an Item stays in memory whatever its size: in progress, a task
/// still running, or the message Claude streams into.
fn pinned(item: &Value, streaming: Option<&str>) -> bool {
    !ended(item)
        || crate::claude::TASK_RECORDS.iter().any(|record| crate::claude::subagent_running(&item[*record]))
        || item["id"].as_str().is_some_and(|id| streaming.is_some_and(|m| id == m || id.starts_with(&format!("{m}:"))))
}

/// The bytes a slice holds: its metadata, its Turns' own fields (Claude's
/// per-Turn scratch among them) and its Items.
fn slice_bytes(slice: &AgentDetail) -> usize {
    let shells: usize = slice.turns.iter().flat_map(|t| t.as_object().into_iter().flatten())
        .filter(|(key, _)| *key != "items").map(|(key, value)| key.len() + 3 + crate::client_view::size_of(value)).sum();
    serde_json::to_value(slice.clone_meta()).map_or(0, |meta| crate::client_view::size_of(&meta)) + shells + held_items(slice)
}

/// The bytes of the Items `slice` holds (gaps excepted).
fn held_items(slice: &AgentDetail) -> usize {
    slice.turns.iter().flat_map(|t| t["items"].as_array().into_iter().flatten())
        .filter(|item| record_rows::gap_of(item).is_none()).map(crate::client_view::size_of).sum()
}

/// Leaves the oldest ended Items of `slice` to their rows, as gaps, until
/// its Items take at most `budget` bytes. Each Turn's newest NEWEST_KEEP
/// entries and pinned Items stay. Only after a write: an Item's place in
/// its array (gaps counted) is then its stored position.
fn evict(slice: &mut AgentDetail, budget: usize) {
    let mut held = held_items(slice);
    for turn in &mut slice.turns {
        let streaming = turn["_claudeMessageId"].as_str().map(str::to_owned);
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else { continue };
        let n = items.len();
        // What the rail reads stays too (`rail::project`): the user messages
        // and the last assistant message with text, and with completed text.
        let mut read: HashSet<usize> = items.iter().enumerate().filter(|(_, i)| i["type"] == "userMessage").map(|(k, _)| k).collect();
        for field in ["text", "_yuzunoCompletedText"] {
            read.extend(items.iter().rposition(|i| i["type"] == "agentMessage"
                && i[field].as_str().is_some_and(|t| !t.trim().is_empty())));
        }
        let mut kept = Vec::with_capacity(n);
        let mut at = 0;
        for (i, item) in std::mem::take(items).into_iter().enumerate() {
            if let Some((_, count)) = record_rows::gap_of(&item) {
                push_gap(&mut kept, at, count);
                at += count;
                continue;
            }
            let keyed = item["id"].as_str().is_some_and(|id| !id.is_empty() && !id.starts_with('~'));
            if held > budget && keyed && i + NEWEST_KEEP < n && !read.contains(&i) && !pinned(&item, streaming.as_deref()) {
                held -= crate::client_view::size_of(&item);
                push_gap(&mut kept, at, 1);
            } else {
                kept.push(item);
            }
            at += 1;
        }
        *items = kept;
    }
}

/// Adds `count` Items from stored position `from` to the gaps of `items`.
fn push_gap(items: &mut Vec<Value>, from: usize, count: usize) {
    if let Some((first, before)) = items.last().and_then(record_rows::gap_of) {
        if first + before == from {
            *items.last_mut().unwrap() = record_rows::gap(first, before + count);
            return;
        }
    }
    items.push(record_rows::gap(from, count));
}

/// After a write, a gap's rows are where its place in the array says (the
/// write moved them): its stored position is that place now.
fn settle_gaps(slice: &mut AgentDetail) {
    for turn in &mut slice.turns {
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else { continue };
        let mut at = 0;
        for item in items.iter_mut() {
            match record_rows::gap_of(item) {
                Some((from, count)) => {
                    if from != at {
                        *item = record_rows::gap(at, count);
                    }
                    at += count;
                }
                None => at += 1,
            }
        }
    }
}

/// Moves the start of each large streamed field of the Items `touched` names
/// in `slice` (and, past IN_PROGRESS_HOLD, of every Item in progress) out of
/// memory: the chunk rows to write, each field keeping its end and noting
/// the rest (`record_rows::SPILLED`). Only text fields of Items with an ID.
fn spill(slice: &mut AgentDetail, touched: &Dirty) -> Vec<record_rows::Chunk> {
    let mut chunks = Vec::new();
    let in_progress: usize = slice.turns.iter().flat_map(|t| t["items"].as_array().into_iter().flatten())
        .filter(|item| record_rows::gap_of(item).is_none() && !ended(item)).map(crate::client_view::size_of).sum();
    let tight = in_progress > IN_PROGRESS_HOLD;
    for turn in &mut slice.turns {
        let Some(tid) = turn["id"].as_str().map(str::to_owned) else { continue };
        let streaming = turn["_claudeMessageId"].as_str().map(str::to_owned);
        let named = touched.turns().get(&tid);
        let all = touched.is_all() || touched.all_turn_rows() || named.is_some_and(|t| t.all_items);
        for item in turn.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
            let Some(id) = item["id"].as_str().filter(|id| !id.is_empty() && !id.starts_with('~')).map(str::to_owned) else { continue };
            // Only what still streams: an ended Item is stored whole.
            let live = !ended(item) || streaming.as_deref().is_some_and(|m| id == m || id.starts_with(&format!("{m}:")));
            if !live {
                continue;
            }
            let reached = all || named.is_some_and(|t| t.items.contains(&id));
            let (hold, keep) = if tight { (STREAM_MIN, STREAM_MIN) } else { (STREAM_HOLD, STREAM_KEEP) };
            if !reached && !tight {
                continue;
            }
            let Some(members) = item.as_object_mut() else { continue };
            let long: Vec<String> = members.iter()
                .filter(|(key, value)| !key.starts_with("_yuzuno") && value.as_str().is_some_and(|text| text.len() > hold))
                .map(|(key, _)| key.clone()).collect();
            for field in long {
                let Some(Value::String(text)) = members.get_mut(&field) else { continue };
                let mut cut = text.len() - keep;
                while !text.is_char_boundary(cut) {
                    cut += 1;
                }
                let head: String = text.drain(..cut).collect();
                // The end alone, not the whole field's buffer, stays held.
                text.shrink_to_fit();
                let notes = members.entry(record_rows::SPILLED).or_insert_with(|| json!({}));
                let note = &mut notes[&field];
                let bytes = note["bytes"].as_u64().unwrap_or(0) + head.len() as u64;
                let lines = note["lines"].as_u64().unwrap_or(0) + head.matches('\n').count() as u64;
                *note = json!({"bytes": bytes, "lines": lines});
                chunks.push(record_rows::Chunk { turn: tid.clone(), item: id.clone(), field, data: head });
            }
        }
    }
    chunks
}

/// The client IDs of the user messages among the Items `dirty` names: the
/// receipts an event may bind or accept.
fn user_clients(d: &AgentDetail, dirty: &Dirty) -> Vec<String> {
    let mut clients: Vec<String> = Vec::new();
    for turn in &d.turns {
        let Some(tid) = turn["id"].as_str() else { continue };
        let touched = dirty.turns().get(tid);
        let all = dirty.is_all() || touched.is_some_and(|t| t.all_items);
        if !all && touched.is_none() {
            continue;
        }
        for item in turn["items"].as_array().into_iter().flatten().filter(|i| i["type"] == "userMessage") {
            let reached = all || item["id"].as_str().is_some_and(|i| touched.is_some_and(|t| t.items.contains(i)));
            if let (true, Some(client)) = (reached, item["clientId"].as_str()) {
                if !clients.iter().any(|c| c == client) {
                    clients.push(client.to_owned());
                }
            }
        }
    }
    clients
}

/// Reads back whole the Claude messages in `slice` (`only` the one with that
/// ID, if given) whose text streamed out of memory: its chunk rows, then its
/// `pending` chunks not written yet, then the end it held. For an event that
/// may confirm their text (`claude::confirms_text`), which puts a completed
/// block where it is in that text. The caller writes each whole, or spilled
/// anew, and drops its old chunks.
fn whole_messages(db: &Connection, id: &str, slice: &mut AgentDetail, pending: &[record_rows::Chunk], only: Option<&str>)
    -> Result<()> {
    for turn in &mut slice.turns {
        let Some(tid) = turn["id"].as_str().map(str::to_owned) else { continue };
        for item in turn.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
            if item["type"] == "agentMessage" && item[record_rows::SPILLED].is_object()
                && only.is_none_or(|message| item["id"] == message) {
                record_rows::unspill_with(db, id, &tid, item, pending)?;
            }
        }
    }
    Ok(())
}

/// The spilled fields of a slice (Turn, Item, field, the end it holds, its
/// note).
fn spilled_fields(slice: &AgentDetail) -> Vec<(String, String, String, Value, Value)> {
    let mut found = Vec::new();
    for turn in &slice.turns {
        let Some(tid) = turn["id"].as_str() else { continue };
        for item in turn["items"].as_array().into_iter().flatten() {
            let (Some(iid), Some(notes)) = (item["id"].as_str(), item[record_rows::SPILLED].as_object()) else { continue };
            for (field, note) in notes {
                found.push((tid.to_owned(), iid.to_owned(), field.clone(), item[field.as_str()].clone(), note.clone()));
            }
        }
    }
    found
}

/// The spilled fields an event set anew (no longer the end they held): no
/// longer noted, their chunks to drop. A field the event left is kept, and
/// so is one it set to the text that streamed (its start, which `streamed`
/// compares with the chunks, then the end held): an Item completed with its
/// output keeps its start in the chunks, not written again.
fn replaced_fields(slice: &mut AgentDetail, before: Vec<(String, String, String, Value, Value)>,
    mut streamed: impl FnMut(&str, &str, &str, &str) -> Result<bool>) -> Result<Vec<(String, String, String)>> {
    let mut replaced = Vec::new();
    for (tid, iid, field, value, note) in before {
        let item = slice.turns.iter_mut().find(|t| t["id"] == tid.as_str())
            .and_then(|t| t.get_mut("items")).and_then(Value::as_array_mut)
            .and_then(|items| items.iter_mut().find(|i| i["id"] == iid.as_str()));
        let changed = match item {
            Some(item) if item[field.as_str()] == value && item[record_rows::SPILLED].get(&field).is_some() => false,
            Some(item) if continued(item, &field, &value, &note, |start| streamed(&tid, &iid, &field, start))? => {
                item[field.as_str()] = value;
                if !item[record_rows::SPILLED].is_object() {
                    item[record_rows::SPILLED] = json!({});
                }
                item[record_rows::SPILLED][field.as_str()] = note;
                false
            }
            Some(item) => {
                if let Some(notes) = item.get_mut(record_rows::SPILLED).and_then(Value::as_object_mut) {
                    notes.remove(&field);
                    if notes.is_empty() {
                        item.as_object_mut().unwrap().remove(record_rows::SPILLED);
                    }
                }
                true
            }
            None => true,
        };
        if changed {
            replaced.push((tid, iid, field));
        }
    }
    Ok(replaced)
}

/// Whether `item`'s `field` is the text that streamed into it: the start
/// its `note` counts (compared by `streamed`), then the end it held. Only a
/// command's output: a message's text is read whole where it is stored
/// (search, the rail, its completed text), so it is written whole.
fn continued(item: &Value, field: &str, held: &Value, note: &Value, streamed: impl FnOnce(&str) -> Result<bool>) -> Result<bool> {
    if item["type"] != "commandExecution" || field != "aggregatedOutput" {
        return Ok(false);
    }
    let (Some(text), Some(end), Some(start)) = (item[field].as_str(), held.as_str(), note["bytes"].as_u64()) else { return Ok(false) };
    let start = start as usize;
    if text.len() != start + end.len() || !text.is_char_boundary(start) || &text[start..] != end {
        return Ok(false);
    }
    streamed(&text[..start])
}

/// The Turn an event names by ID, if it does.
fn named_turn(data: &Value) -> Vec<String> {
    data["turnId"].as_str().or_else(|| data["turn"]["id"].as_str()).map(str::to_owned).into_iter().collect()
}

/// The Items an event names, by Turn when it says which: what must be in
/// memory, not in a gap, before it is applied (`load_named`).
fn event_items(db: &Connection, id: &str, kind: &str, data: &Value) -> Result<Vec<(String, String)>> {
    let turn = data["turnId"].as_str().or_else(|| data["turn"]["id"].as_str()).map(str::to_owned);
    let mut ids: Vec<String> = Vec::new();
    for value in [&data["itemId"], &data["item"]["id"]] {
        ids.extend(value.as_str().map(str::to_owned));
    }
    for item in data["turn"]["items"].as_array().into_iter().flatten() {
        ids.extend(item["id"].as_str().map(str::to_owned));
    }
    let mut found = Vec::new();
    if kind.starts_with("claude/") {
        let event = &data["event"];
        for value in [&event["parent_tool_use_id"], &event["tool_use_id"], &event["message"]["id"]] {
            ids.extend(value.as_str().map(str::to_owned));
        }
        for block in event["message"]["content"].as_array().into_iter().flatten() {
            for value in [&block["id"], &block["tool_use_id"]] {
                ids.extend(value.as_str().map(str::to_owned));
            }
        }
        if let Some(task) = event["task_id"].as_str() {
            found.extend(record_rows::keyed(db, id, "task", task)?);
        }
        // Claude's Items are found in whichever Turn holds them.
        for item in ids {
            if let Some(turn) = record_rows::item_turn(db, id, &item)? {
                found.push((turn, item));
            }
        }
        return Ok(found);
    }
    if let Some(turn) = turn {
        found.extend(ids.into_iter().map(|item| (turn.clone(), item)));
    }
    Ok(found)
}

/// The receipts of `after` that differ from `before` (or are new).
fn changed_receipts<'a>(before: &[MessageReceipt], after: &'a [MessageReceipt]) -> Vec<&'a MessageReceipt> {
    let old: HashMap<&str, &MessageReceipt> = before.iter().map(|r| (r.input.client_message_id.as_str(), r)).collect();
    after.iter().filter(|r| old.get(r.input.client_message_id.as_str()).is_none_or(|was| {
        serde_json::to_value(was).ok() != serde_json::to_value(r).ok()
    })).collect()
}

/// What a Core that stopped leaves an Agent's record saying (`Store::open`):
/// disconnected and offline, its requests and context usage stale, a message
/// it was sending of unknown outcome, and an error when its newest Turn was
/// still running. No Turn changes.
fn mark_restarted(d: &mut AgentDetail, newest_in_progress: bool) {
    if let Some(usage) = &mut d.context_usage { usage.stale = true; }
    for receipt in &mut d.message_receipts {
        if receipt.status == "sending" { receipt.status = "uncertain".into(); }
    }
    d.agent.connection_state = "disconnected".into();
    // An unknown RPC outcome stays unknown across service restarts.
    if d.agent.status != "uncertain" { d.agent.status = "offline".into(); }
    for r in &mut d.pending { r.stale = true; }
    if newest_in_progress {
        d.agent.error = Some("Workspace 服务已重启；上次执行是否完成尚未确认。发送新消息时将恢复原会话。".into());
    }
}

/// The Workspace's exclusive lock, held as long as the file stays open.
pub(crate) fn lock_workspace(path: &Path) -> Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let lock = match OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
    {
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => File::open(path.with_extension("lock")),
        opened => opened,
    }
    .context("无法打开 Workspace 独占锁")?;
    lock.try_lock().context(
        "此 Workspace 已被另一个 Core 使用，或无法取得独占锁；请连接现有 Core，或使用另一个数据目录",
    )?;
    Ok(lock)
}

/// A saved-body page and its complete navigation metadata. Read statistics are
/// internal diagnostics and are not serialized into the client protocol.
pub struct ConversationWindow {
    pub detail: AgentDetail,
    pub conversation: Value,
    pub stats: record_rows::window::ReadStats,
}

fn project_window(
    db: &Connection, mut index: AgentDetail, query: &crate::conversation_window::Query,
    mut read: impl FnMut(usize, usize) -> Result<Value>,
) -> Result<std::result::Result<(AgentDetail, Value), crate::client_view::Missing>> {
    crate::mailbox_notice::annotate(db, &mut index)?;
    crate::codex_sessions::annotate_imported_questions_in(db, &mut index)?;
    index.agent.project_id = crate::projects::agent_project(db, &index.agent.id)?;
    let found = crate::conversation_window::project_from(&index.turns, query, |t, i| {
        let mut item = crate::client_view::item_owned(read(t, i)?, &index.pending);
        // The complete index has already been annotated from this snapshot.
        // Apply the same item provenance to its original body before sizing it.
        if let Some(object) = item.as_object_mut() {
            object.remove("_yuzunoMailbox");
            for key in ["_yuzunoSource", "_yuzunoMailbox"] {
                if let Some(value) = index.turns[t]["items"][i].get(key) { object.insert(key.into(), value.clone()); }
            }
        }
        Ok(item)
    })?;
    Ok(found.map(|(turns, metadata)| {
        index.turns = turns;
        (crate::client_view::detail(index), metadata)
    }))
}

/// `project_window` of a sparse index (`record_rows::window::sparse`): the
/// Turns hold only the Items every window lists, at positions `ords`.
#[allow(clippy::too_many_arguments)]
fn project_window_marked(
    db: &Connection, mut index: AgentDetail, ords: &[Vec<usize>], counts: &[usize], query: &crate::conversation_window::Query,
    position: impl FnMut(usize, &str) -> Result<Option<usize>>, mut read: impl FnMut(usize, usize) -> Result<Value>,
) -> Result<std::result::Result<(AgentDetail, Value), crate::client_view::Missing>> {
    crate::mailbox_notice::annotate(db, &mut index)?;
    crate::codex_sessions::annotate_imported_questions_in(db, &mut index)?;
    index.agent.project_id = crate::projects::agent_project(db, &index.agent.id)?;
    let found = crate::conversation_window::project_marked(&index.turns, ords, counts, query, position, |t, i| {
        let mut item = crate::client_view::item_owned(read(t, i)?, &index.pending);
        // The index has been annotated from this snapshot: its provenance on
        // the body too, before sizing it.
        if let Some(object) = item.as_object_mut() {
            object.remove("_yuzunoMailbox");
            let listed = ords[t].iter().position(|ord| *ord == i).map(|k| &index.turns[t]["items"][k]);
            for key in ["_yuzunoSource", "_yuzunoMailbox"] {
                if let Some(value) = listed.and_then(|entry| entry.get(key)) { object.insert(key.into(), value.clone()); }
            }
        }
        Ok(item)
    })?;
    Ok(found.map(|(turns, metadata)| {
        index.turns = turns;
        (crate::client_view::detail(index), metadata)
    }))
}

/// The completion check (`completed_before`, `record_recovered_completion`)
/// looks a Turn's completion up by Agent and Turn ID.
const COMPLETION_INDEX: &str = "CREATE INDEX IF NOT EXISTS journal_turn_completed
    ON journal(agent_id, json_extract(data,'$.turn.id')) WHERE kind='turn/completed'";
/// The busy timeout of every Store connection.
const BUSY_TIMEOUT: Duration = Duration::from_secs(3);

/// `conversation_window::Search` over an Agent's rows: the window's index
/// and each message's row, read in order until the search has 50 results.
fn search_rows(db: &Connection, id: &str, query: &str) -> Result<(Vec<Value>, Vec<record_rows::window::Fill>)> {
    use crate::conversation_window::Search;
    ensure!(record_rows::rows_fit(db, id)?, Damaged { agent: id.into(), cause: "its rows do not fit together".into() });
    let mut search = Search::new(query).expect("searchable");
    // Turn by Turn, one message at a time: never every Item at once (T-140).
    for (t, turn) in record_rows::turn_ids(db, id)?.iter().enumerate() {
        let tid = Value::from(turn.as_str());
        if !record_rows::window::messages(db, id, turn, |item| Ok(search.item(t, &tid, &item)))? {
            break;
        }
    }
    Ok((search.results, Vec::new()))
}

/// The Turn an event changes, for loading it before it is applied: the one
/// it names, or, for a Claude sub-agent's frame or task event, the one
/// holding the call that started it (found by its keys, not by reading every
/// Turn).
fn event_turns(db: &Connection, id: &str, kind: &str, data: &Value) -> Result<Vec<String>> {
    let mut turns = named_turn(data);
    if kind.starts_with("claude/") {
        let event = &data["event"];
        if let Some(call) = event["parent_tool_use_id"].as_str().or_else(|| {
            crate::claude::subagent_event(event).then(|| event["tool_use_id"].as_str()).flatten()
        }) {
            turns.extend(record_rows::item_turn(db, id, call)?);
        }
        if let Some(task) = event["task_id"].as_str().filter(|_| crate::claude::subagent_event(event)) {
            turns.extend(record_rows::keyed(db, id, "task", task)?.into_iter().map(|(turn, _)| turn));
        }
        // A tool result names its call, which may be in another Turn.
        for block in event["message"]["content"].as_array().into_iter().flatten() {
            if let Some(call) = block["tool_use_id"].as_str() {
                turns.extend(record_rows::item_turn(db, id, call)?);
            }
        }
    }
    Ok(turns)
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let workspace_lock = lock_workspace(path)?;
        let db = Connection::open(path)?;
        db.busy_timeout(BUSY_TIMEOUT)?;
        // An earlier Core's Workspace is refused before anything is written
        // to it (docs/adr/0002-session-store-new-data-directory.md).
        record_rows::check_store(&db)?;
        // FULL is SQLite's default; stated because the writer's unsynced
        // connection uses NORMAL and this one must never (see `db`).
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS journal_agent ON journal(agent_id,seq);
            CREATE TABLE IF NOT EXISTS workspace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS machines(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            PRAGMA user_version=2;")?;
        record_rows::mark_store(&db)?;
        crate::collaboration_store::migrate(&db)?;
        crate::projects::migrate(&db)?;
        crate::services::migrate(&db)?;
        crate::github::store::migrate(&db)?;
        crate::pr_review::store::migrate(&db)?;
        crate::pr_operations::store::migrate(&db)?;
        crate::jobs::store::migrate(&db)?;
        crate::ci_monitor::store::migrate(&db)?;
        crate::delivery::store::migrate(&db)?;
        crate::machines::migrate(&db)?;
        crate::codex_sessions::migrate(&db)?;
        crate::rewind::migrate(&db)?;
        crate::claude_quota::migrate(&db)?;
        crate::results::migrate(&db)?;
        crate::project_brief::migrate(&db)?;
        crate::brief_turns::migrate(&db)?;
        crate::task_workspaces::migrate(&db)?;
        record_rows::migrate(&db)?;
        db.execute_batch(COMPLETION_INDEX)?;
        db.execute("INSERT OR IGNORE INTO workspace_meta(key,value) VALUES('workspaceId',?1)",
            [uuid::Uuid::new_v4().to_string()])?;
        let store = Self {
            db: crate::db::Db::new(path, db)?,
            memory: Mutex::new(Memory {
                hot: HashMap::new(),
                briefs: HashMap::new(),
                announce: HashSet::new(),
                versions: HashMap::new(),
                last_rev: 0,
                revs: HashMap::new(),
                evidence: HashMap::new(),
                damaged: HashSet::new(),
            }),
            records: Mutex::new(HashMap::new()),
            workspace_lock: crate::older_cores::Guard::new(workspace_lock, path.with_extension("lock")),
        };
        // Disk is historical evidence, never proof a process is still running.
        for a in store.agents()? {
            if a.closed_at.is_some() { continue; }
            if let Err(error) = store.mark_restarted(&a.id) {
                eprintln!("Workspace could not mark Agent {} restarted: {error:#}", a.id);
            }
        }
        store.settle_older_cores();
        Ok(store)
    }

    /// `Store::open`'s restart marking: the metadata, the receipts still
    /// being sent and the newest Turn's status are all it reads, and it
    /// changes only the metadata and those receipts.
    fn mark_restarted(&self, id: &str) -> Result<()> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        let (mut d, newest_in_progress) = {
            let db = self.db.read()?;
            let mut d = record_rows::load_meta(&db, id)?.context("Agent 不存在")?;
            d.message_receipts = record_rows::open_receipts(&db, id)?;
            let newest = record_rows::newest_turns(&db, id, 1)?;
            let in_progress = !newest.is_empty() && record_rows::open_turns(&db, id)?.last() == newest.last();
            (d, in_progress)
        };
        let before = d.message_receipts.clone();
        mark_restarted(&mut d, newest_in_progress);
        d.agent.pending_count = d.pending.len() as u64;
        d.agent.updated_at = now();
        let receipts = changed_receipts(&before, &d.message_receipts);
        let body = record_rows::MetaBody::of(&d)?;
        let rewrite;
        {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'workspace/restarted','{}',?2)", params![id, now()])?;
            d.agent.last_seq = tx.last_insert_rowid();
            d.agent.unread_count = unread(&tx, id, d.agent.reviewed_seq)?;
            record_rows::write_meta(&tx, id, &body, &d.agent)?;
            record_rows::write_receipts(&tx, id, &receipts)?;
            tx.commit()?;
        }
        rewrite.done(|memory| {
            memory.event(id, "workspace/restarted", &json!({}));
            memory.briefs.remove(id);
        });
        Ok(())
    }

    /// The Agent's record lock (see the lock order on `Store`).
    fn record_lock(&self, id: &str) -> Arc<parking_lot::Mutex<()>> {
        self.records.lock().unwrap().entry(id.into()).or_default().clone()
    }

    /// Starts a write of the Agent's rows (see `Rewrite`): call it with the
    /// record lock and the writer held, right before the transaction.
    fn rewrite<'a>(&'a self, id: &'a str) -> Rewrite<'a> {
        self.memory.lock().unwrap().bump_version(id);
        Rewrite { store: self, id, done: false }
    }

    /// After a read or change found the Agent's rows damaged: no change is
    /// made to it in this process.
    fn note_damage(&self, id: &str, error: &anyhow::Error) {
        if error.downcast_ref::<Damaged>().is_some() {
            self.memory.lock().unwrap().damaged.insert(id.into());
        }
    }

    fn ensure_undamaged(&self, id: &str) -> Result<()> {
        ensure!(!self.memory.lock().unwrap().damaged.contains(id),
            "Agent {id} 的记录无法读取，此 Agent 暂不写入；其他 Agent 不受影响");
        Ok(())
    }

    /// The Agent's hot slice, if it is in memory.
    fn hot(&self, id: &str) -> Option<Arc<RwLock<AgentDetail>>> {
        self.memory.lock().unwrap().hot.get(id).map(|hot| hot.slice.clone())
    }

    /// A requested project is linked in the same transaction, so a new Agent
    /// never exists outside the project it was created for.
    pub fn insert(&self, detail: &AgentDetail) -> Result<()> {
        self.insert_record(detail, false)
    }

    /// A newly created Agent, refused if its SSH machine is no longer
    /// registered.
    pub fn insert_created(&self, detail: &AgentDetail) -> Result<()> {
        self.insert_record(detail, true)
    }

    fn insert_record(&self, detail: &AgentDetail, machine_registered: bool) -> Result<()> {
        let mut detail = detail.clone();
        detail.agent.work_summary = None;
        let project = detail.agent.project_id.take();
        let rows = record_rows::split(&detail)?;
        let _kept_out = self.keep_older_cores_out_for(detail.agent.remote.as_ref()
            .and_then(|remote| crate::older_cores::agent_hazard(&detail.agent.name, &remote.machine)))?;
        let lock = self.record_lock(&detail.agent.id);
        let _record = lock.lock();
        let rewrite;
        {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(&detail.agent.id);
            let tx = db.transaction()?;
            if let Some(remote) = detail.agent.remote.as_ref().filter(|_| machine_registered) {
                let registered: bool = tx.query_row(
                    "SELECT EXISTS(SELECT 1 FROM machines WHERE id=?1)", [&remote.machine.id], |r| r.get(0))?;
                if !registered {
                    bail!("{} was removed while this agent was being created", remote.machine.name);
                }
            }
            record_rows::insert(&tx, &detail.agent.id, &rows)?;
            if let Some(project) = project.as_deref() {
                crate::projects::set_agent_project_in(&tx, &detail.agent.id, Some(project))?;
            }
            tx.commit()?;
        }
        rewrite.done(|memory| memory.changed(&detail.agent.id));
        // An Agent's session keeps older Cores out (`older_core_hazard`).
        self.keep_older_cores_out_now();
        Ok(())
    }

    /// Delete only this Workspace's record and journal. Native sessions and all
    /// project/runtime files are deliberately outside this transaction.
    pub fn delete_closed_agent(&self, id: &str) -> Result<()> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        let rewrite;
        {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            let closed: bool = tx.query_row("SELECT json_extract(data,'$.agent.closedAt') IS NOT NULL FROM agents WHERE id=?1",
                [id], |r| r.get(0))?;
            anyhow::ensure!(closed, "请先关闭 Agent，再删除 Workspace 记录");
            record_rows::delete_rows(&tx, id)?;
            tx.execute("DELETE FROM journal WHERE agent_id=?1", [id])?;
            tx.execute("DELETE FROM agents WHERE id=?1", [id])?;
            crate::results::delete_agent(&tx, id)?;
            crate::project_brief::delete_agent(&tx, id)?;
            crate::reading_handoff::delete_agent(&tx, id)?;
            crate::codex_sessions::release_forks(&tx, id)?;
            tx.commit()?;
        }
        rewrite.done(|memory| {
            memory.hot.remove(id);
            memory.briefs.remove(id);
            memory.announce.remove(id);
            memory.evidence.remove(id);
            memory.damaged.remove(id);
            memory.changed(id);
        });
        self.records.lock().unwrap().remove(id);
        Ok(())
    }

    pub fn workspace_id(&self) -> Result<String> {
        Ok(self.db.read()?.query_row(
            "SELECT value FROM workspace_meta WHERE key='workspaceId'", [], |r| r.get(0))?)
    }

    pub fn add_machine(&self, machine: &RemoteMachine) -> Result<()> {
        let _kept_out = self.keep_older_cores_out_for(crate::older_cores::machine_hazard(machine))?;
        self.db.write()?.execute("INSERT INTO machines(id,data) VALUES(?1,?2)",
            params![machine.id, serde_json::to_string(machine)?])?;
        Ok(())
    }

    /// Saves an edited machine for new Agents, Jobs and checks; Agents
    /// already on it keep the copy they were created with, and a Job sent
    /// there keeps the data root it was sent to. A changed destination,
    /// executable, folder, data root or `contained` drops the last check,
    /// which described the old one.
    pub fn update_machine(&self, machine: &RemoteMachine) -> Result<()> {
        let _kept_out = self.keep_older_cores_out_for(crate::older_cores::machine_hazard(machine))?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let raw: Option<String> = tx.query_row(
            "SELECT data FROM machines WHERE id=?1", [&machine.id], |r| r.get(0)).optional()?;
        let before: RemoteMachine = serde_json::from_str(&raw.context("远程机器不存在")?)?;
        if before.target != machine.target && machine_jobs(&tx, &machine.id)? > 0 {
            bail!("Jobs still run on this machine; change its SSH destination once they finish");
        }
        tx.execute("UPDATE machines SET data=?2 WHERE id=?1",
            params![machine.id, serde_json::to_string(machine)?])?;
        if (&before.target, &before.codex, &before.default_cwd, before.root(), before.contained)
            != (&machine.target, &machine.codex, &machine.default_cwd, machine.root(), machine.contained)
        {
            tx.execute("DELETE FROM machine_checks WHERE machine_id=?1", [&machine.id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Removes a machine and its last check. Refused while an open Agent works
    /// there or an unfinished Job runs there.
    pub fn remove_machine(&self, id: &str) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let open: Vec<String> = tx.prepare(
            "SELECT COALESCE(json_extract(data,'$.agent.name'),id) FROM agents
             WHERE json_extract(data,'$.agent.remote.machine.id')=?1 AND json_extract(data,'$.agent.closedAt') IS NULL
             ORDER BY rowid")?
            .query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        if !open.is_empty() {
            bail!("{} still {} on this machine. Close {} first, then remove it.", open.join(", "),
                if open.len() == 1 { "works" } else { "work" }, if open.len() == 1 { "that agent" } else { "those agents" });
        }
        if machine_jobs(&tx, id)? > 0 {
            bail!("Jobs still run on this machine; remove it once they finish");
        }
        if tx.execute("DELETE FROM machines WHERE id=?1", [id])? == 0 {
            bail!("远程机器不存在");
        }
        tx.execute("DELETE FROM machine_checks WHERE machine_id=?1", [id])?;
        tx.commit()?;
        Ok(())
    }

    pub fn machines(&self) -> Result<Vec<RemoteMachine>> {
        let db = self.db.read()?;
        let mut query = db.prepare("SELECT data FROM machines ORDER BY rowid")?;
        let rows = query.query_map([], |r| r.get::<_, String>(0))?;
        rows.map(|r| Ok(serde_json::from_str(&r?)?)).collect()
    }

    pub fn machine(&self, id: &str) -> Result<RemoteMachine> {
        let raw: Option<String> = self.db.read()?.query_row(
            "SELECT data FROM machines WHERE id=?1", [id], |r| r.get(0)).optional()?;
        Ok(serde_json::from_str(&raw.context("远程机器不存在")?)?)
    }

    /// Writes an active Agent's streamed output its rows lack, if any, so a
    /// read of the rows sees it.
    fn settle_unwritten(&self, id: &str) -> Result<()> {
        let unwritten = self.memory.lock().unwrap().hot.get(id).is_some_and(|hot| hot.unwritten_since.is_some());
        if !unwritten {
            return Ok(());
        }
        let lock = self.record_lock(id);
        let _record = lock.lock();
        self.write_unwritten(id)
    }

    /// `sel` of an Agent as it is now: its metadata, the Turns selected
    /// (without payloads; see `Sel`) and their receipts, read in one snapshot
    /// that holds exactly the changes up to the rev it carries. Streamed
    /// output only in memory is written first.
    pub fn view(&self, id: &str, sel: Sel) -> Result<AgentDetail> {
        self.settle_unwritten(id)?;
        let mut attempt = 0;
        loop {
            let lock = (attempt >= 2).then(|| self.record_lock(id));
            let _record = lock.as_ref().map(|lock| lock.lock());
            let (version, rev) = {
                let memory = self.memory.lock().unwrap();
                (memory.version(id), memory.rev(id))
            };
            if version % 2 == 1 {
                attempt += 1;
                std::thread::yield_now();
                continue;
            }
            let read = {
                let db = self.db.read()?;
                // With the provenance of mailbox notices, as clients see it.
                read_slice(&db, id, &sel).and_then(|found| match found {
                    Some(mut detail) => {
                        crate::mailbox_notice::annotate(&db, &mut detail)?;
                        Ok(Some(detail))
                    }
                    None => Ok(None),
                })
            };
            let mut detail = match read {
                Ok(found) => found.context("Agent 不存在")?,
                Err(error) => {
                    self.note_damage(id, &error);
                    return Err(error);
                }
            };
            if self.memory.lock().unwrap().version(id) != version {
                attempt += 1;
                continue;
            }
            detail.agent.rev = rev;
            detail.agent.project_id = self.agent_project(id)?;
            if !matches!(sel, Sel::Meta) {
                detail.agent.work_summary = crate::rail::project(&detail);
            }
            return Ok(detail);
        }
    }

    /// What a send checks: the metadata, the receipts not settled and the
    /// open and newest Turns (`view` of `Sel::Open`).
    pub fn send_view(&self, id: &str) -> Result<AgentDetail> {
        self.view(id, Sel::Open)
    }

    /// The newest `n` Turns' IDs and statuses, oldest first.
    pub fn newest_turn_states(&self, id: &str, n: usize) -> Result<Vec<(String, Option<String>)>> {
        record_rows::newest_turn_states(&*self.db.read()?, id, n)
    }

    /// One Turn as stored now, without payloads; None if there is none.
    pub fn turn(&self, id: &str, turn: &str) -> Result<Option<Value>> {
        self.settle_unwritten(id)?;
        record_rows::load_turn(&*self.db.read()?, id, turn, false)
    }

    /// The receipt of the message with this client ID, settled or not.
    pub fn receipt(&self, id: &str, client: &str) -> Result<Option<MessageReceipt>> {
        record_rows::receipt(&*self.db.read()?, id, client)
    }

    /// Whether a message not rejected answers this form (result and form
    /// ID) or this native question (Turn and Item ID), settled or not.
    pub fn answered(&self, id: &str, form: Option<(&str, &str)>, question: Option<(&str, &str)>) -> Result<bool> {
        record_rows::answered(&*self.db.read()?, id, form, question)
    }

    /// Every receipt of the Agent, one at a time (deleting its images).
    pub fn each_receipt(&self, id: &str, each: impl FnMut(MessageReceipt)) -> Result<()> {
        record_rows::each_receipt(&*self.db.read()?, id, each)
    }

    /// The Turns of the Items with this key (`record_rows::index_keys`),
    /// newest first.
    pub fn keyed_turns(&self, id: &str, kind: &str, key: Option<&str>) -> Result<Vec<String>> {
        self.settle_unwritten(id)?;
        self.keyed_turns_written(id, kind, key)
    }

    /// `keyed_turns` once the Agent's streamed output is written: for a
    /// caller that holds the record lock and wrote it.
    fn keyed_turns_written(&self, id: &str, kind: &str, key: Option<&str>) -> Result<Vec<String>> {
        let db = self.db.read()?;
        Ok(match key {
            Some(key) => {
                let mut turns: Vec<String> = Vec::new();
                for (turn, _) in record_rows::keyed(&db, id, kind, key)? {
                    if !turns.contains(&turn) { turns.push(turn); }
                }
                turns
            }
            None => record_rows::keyed_turns(&db, id, kind)?,
        })
    }

    /// The Turns a Claude runtime's end changes (T-140): those holding a
    /// task still able to report and those showing a message not yet
    /// confirmed (found by their keys), with the open and newest ones.
    pub fn runtime_end_turns(&self, id: &str) -> Result<Sel> {
        self.settle_unwritten(id)?;
        let db = self.db.read()?;
        let mut turns = record_rows::keyed_turns(&db, id, "running")?;
        for receipt in record_rows::open_receipts(&db, id)? {
            turns.extend(record_rows::keyed(&db, id, "client", &receipt.input.client_message_id)?.into_iter().map(|(turn, _)| turn));
        }
        Ok(Sel::Turns(turns))
    }

    /// Every key of this kind the Agent's Items have, oldest first.
    pub fn keys_of(&self, id: &str, kind: &str) -> Result<Vec<String>> {
        self.settle_unwritten(id)?;
        record_rows::keys_of(&*self.db.read()?, id, kind)
    }

    /// The IDs of every Turn the Agent has, oldest first (IDs only).
    pub fn turn_ids(&self, id: &str) -> Result<Vec<String>> {
        record_rows::turn_ids(&*self.db.read()?, id)
    }

    /// The receipts a slice holding these Turns works with: those not
    /// settled, and the settled ones kept with these Turns.
    pub fn receipts_for(&self, id: &str, turns: &[String]) -> Result<Vec<MessageReceipt>> {
        slice_receipts(&*self.db.read()?, id, turns)
    }

    /// How many Turns the Agent has.
    pub fn turn_count(&self, id: &str) -> Result<usize> {
        record_rows::turn_count(&*self.db.read()?, id)
    }

    /// Every Turn of the Agent, oldest first, read without payloads and
    /// handed to `each` one at a time until it says to stop: for the few
    /// reads that need a whole history (rewind's local archive, a Codex
    /// history page's saved Turns). Nothing keeps what it reads.
    pub fn scan(&self, id: &str, each: impl FnMut(Value) -> Result<bool>) -> Result<()> {
        self.settle_unwritten(id)?;
        record_rows::scan(&*self.db.read()?, id, false, each)
    }

    /// What a rewind keeps of the local Turns it removes: the metadata and
    /// these Turns with their payloads, serialized one Turn at a time (only
    /// one Turn is held). None past `max` bytes.
    pub fn archive(&self, id: &str, turns: &[String], max: usize) -> Result<Option<String>> {
        self.settle_unwritten(id)?;
        // One snapshot: a read connection holds one until dropped.
        let db = self.db.read()?;
        let meta = record_rows::load_meta(&db, id)?.context("Agent 不存在")?;
        let mut out = format!("{{\"meta\":{},\"turns\":[", serde_json::to_string(&meta)?);
        let mut first = true;
        for turn in turns {
            // A Turn named but not stored adds nothing, not even its comma.
            for (_, value) in record_rows::load_turns(&db, id, std::slice::from_ref(turn), true)? {
                if !first { out.push(','); }
                first = false;
                out.push_str(&serde_json::to_string(&value)?);
            }
            if out.len() > max {
                return Ok(None);
            }
        }
        out.push_str("]}");
        Ok((out.len() <= max).then_some(out))
    }

    /// The Agent's pending native requests.
    pub fn pending(&self, id: &str) -> Result<Vec<PendingRequest>> {
        if let Some(hot) = self.hot(id) {
            return Ok(hot.read().pending.clone());
        }
        Ok(record_rows::load_meta(&*self.db.read()?, id)?.context("Agent 不存在")?.pending)
    }

    /// The direct sub-agent `thread` of Agent `id` as its own Turns record it
    /// (`subagents::recorded_child`), found by its key.
    pub fn recorded_child(&self, id: &str, thread: &str) -> Result<Option<Value>> {
        self.settle_unwritten(id)?;
        let db = self.db.read()?;
        for (turn, item) in record_rows::keyed(&db, id, "child", thread)? {
            if let Some(found) = record_rows::load_item(&db, id, Some(&turn), &item, false)? {
                let mut detail = AgentDetail { turns: vec![found], ..record_rows::load_meta(&db, id)?.context("Agent 不存在")? };
                detail.turns.truncate(1);
                if let Some(child) = crate::subagents::recorded_child(&detail, thread) {
                    return Ok(Some(child));
                }
            }
        }
        Ok(None)
    }

    /// What the detail API sends: the client window, newest first (see
    /// `client_window`): a client never gets a whole history at once.
    pub fn client_detail(&self, id: &str) -> Result<AgentDetail> {
        let query = crate::conversation_window::Query::default();
        match self.client_window(id, &query)? {
            Ok(window) => Ok(window.detail),
            Err(missing) => bail!("{missing:?}"),
        }
    }

    /// `conversation_window::search` over the Agent's messages: the window's
    /// index and each message's row, read one at a time until there are 50
    /// results. A query that finds nothing (blank or too long) finds nothing.
    pub fn conversation_search(&self, id: &str, query: &str) -> Result<Vec<Value>> {
        use crate::conversation_window::Search;
        ensure!(record_rows::exists(&*self.db.read()?, id)?, "Agent 不存在");
        if Search::new(query).is_none() {
            return Ok(Vec::new());
        }
        self.settle_unwritten(id)?;
        let (results, fills) = {
            let db = self.db.read()?;
            search_rows(&db, id, query).inspect_err(|error| self.note_damage(id, error))?
        };
        if !fills.is_empty() {
            let mut writer = self.db.write()?;
            let tx = writer.transaction()?;
            record_rows::window::fill(&tx, id, fills)?;
            tx.commit()?;
        }
        Ok(results)
    }

    /// The window clients are shown of an Agent's conversation: the light
    /// index of every Turn and Item (small per Item) and only the bodies the
    /// window holds, each read from its row.
    pub fn client_window(&self, id: &str, query: &crate::conversation_window::Query)
        -> Result<std::result::Result<ConversationWindow, crate::client_view::Missing>> {
        self.client_window_racing(id, query, || {})
    }

    /// `client_window`, running `unlocked` after the rows are read and before
    /// the version is checked again; tests race writes there.
    fn client_window_racing(&self, id: &str, query: &crate::conversation_window::Query, mut unlocked: impl FnMut())
        -> Result<std::result::Result<ConversationWindow, crate::client_view::Missing>> {
        // An active Agent's window is read under its record lock at once: its
        // streamed output written first, its rows unchanged until read, and
        // no retries while it streams. Another's, without, retried on writes.
        let mut attempt = if self.hot(id).is_some() { 2 } else { 0 };
        loop {
            let lock = (attempt >= 2).then(|| self.record_lock(id));
            let _record = lock.as_ref().map(|lock| lock.lock());
            if _record.is_some() {
                self.write_unwritten(id)?;
            }
            let (version, rev) = {
                let memory = self.memory.lock().unwrap();
                (memory.version(id), memory.rev(id))
            };
            if version % 2 == 1 {
                attempt += 1;
                std::thread::yield_now();
                continue;
            }
            let (found, fills) = {
                let db = self.db.read()?;
                match self.window_rows(&db, id, query) {
                    Ok(read) => read,
                    Err(error) if error.downcast_ref::<Damaged>().is_some() => {
                        self.note_damage(id, &error);
                        return Ok(self.damaged_window(&db, id, query, &error)?.map(|mut window| {
                            window.detail.agent.rev = rev;
                            window
                        }));
                    }
                    Err(error) => return Err(error),
                }
            };
            unlocked();
            // Streamed output that arrived meanwhile is written before the
            // next attempt reads the rows: under the record lock this attempt
            // holds, or taking it.
            if self.memory.lock().unwrap().hot.get(id).is_some_and(|hot| hot.unwritten_since.is_some()) {
                drop(found);
                match &_record {
                    Some(_) => self.write_unwritten(id)?,
                    None => self.settle_unwritten(id)?,
                }
                attempt += 1;
                continue;
            }
            if self.memory.lock().unwrap().version(id) != version {
                attempt += 1;
                continue;
            }
            // Cache publication is conditional on unchanged source rows.
            if !fills.is_empty() {
                let mut writer = self.db.write()?;
                let tx = writer.transaction()?;
                record_rows::window::fill(&tx, id, fills)?;
                tx.commit()?;
            }
            return Ok(found.map(|mut window| { window.detail.agent.rev = rev; window }));
        }
    }

    /// The window of an Agent whose rows do not fit together: its metadata,
    /// with why, and no Turns, so it is shown rather than its read failing.
    fn damaged_window(&self, db: &Connection, id: &str, query: &crate::conversation_window::Query, error: &anyhow::Error)
        -> Result<std::result::Result<ConversationWindow, crate::client_view::Missing>> {
        let mut meta = record_rows::load_meta(db, id)?.context("Agent 不存在")?;
        meta.message_receipts = record_rows::open_receipts(db, id)?;
        meta.agent.status = "error".into();
        meta.agent.error = Some(format!("{error:#}"));
        let found = project_window(db, meta, query, |_, _| bail!("a damaged record has no Items to read"))?;
        Ok(found.map(|(detail, conversation)| ConversationWindow { detail, conversation,
            stats: record_rows::window::ReadStats { source: "damaged", ..Default::default() } }))
    }

    /// A window from the rows without every Item (`record_rows::window::
    /// sparse`): the Turns' rows, the Items every window lists, and the
    /// bodies it shows, read one at a time (T-140).
    fn window_rows(&self, db: &Connection, id: &str, query: &crate::conversation_window::Query)
        -> Result<(std::result::Result<ConversationWindow, crate::client_view::Missing>, Vec<record_rows::window::Fill>)> {
        let record_rows::window::Sparse { mut detail, counts, keys, ords, fills, mut stats } = record_rows::window::sparse(db, id)?;
        // Its receipts not settled; those of the Turns shown are added below.
        detail.message_receipts = record_rows::open_receipts(db, id)?;
        let wanted: HashSet<String> = crate::client_view::referenced(&detail.pending).into_iter().map(str::to_owned).collect();
        let read = |stats: &mut record_rows::window::ReadStats, t: usize, i: usize| -> Result<Value> {
            let (key, item) = record_rows::window::key_at(db, id, &keys[t], i)?.context("an Item's position has no row")?;
            // The Items pending requests name are sent whole, by their ID.
            let whole = item.as_deref().is_some_and(|item| wanted.contains(item));
            record_rows::window::item(db, id, &keys[t], &key, whole, stats)
        };
        let mut bodies: HashMap<(usize, usize), Value> = HashMap::new();
        // The rail reads only the first user message and the last two
        // assistant candidates of the newest Turn.
        let mut rail = crate::conversation_window::header(&detail);
        let mut kept = Vec::new();
        if let Some(t) = detail.turns.len().checked_sub(1) {
            let mut turn = crate::conversation_window::turn_shell(&detail.turns[t]);
            let mut positions: Vec<usize> = detail.turns[t]["items"].as_array().into_iter().flatten().zip(&ords[t])
                .find(|(item, _)| item["type"] == "userMessage").map(|(_, ord)| *ord).into_iter().collect();
            for field in ["text", "_yuzunoCompletedText"] {
                positions.extend(record_rows::window::last_message(db, id, &keys[t], field)?);
            }
            positions.sort_unstable();
            positions.dedup();
            for i in positions {
                let item = read(&mut stats, t, i)?;
                turn["items"].as_array_mut().unwrap().push(item.clone());
                kept.push(((t, i), item));
            }
            rail.turns.push(turn);
        }
        detail.agent.work_summary = crate::rail::project(&rail);
        drop(rail);
        bodies.extend(kept);
        let mut body = |stats: &mut record_rows::window::ReadStats, t: usize, i: usize| -> Result<Value> {
            match bodies.remove(&(t, i)) {
                Some(item) => Ok(item),
                None => read(stats, t, i),
            }
        };
        let found = {
            let position = |t: usize, item: &str| record_rows::window::first_position(db, id, &keys[t], item);
            project_window_marked(db, detail, &ords, &counts, query, position, |t, i| body(&mut stats, t, i))?
        };
        let found = match found {
            Ok((mut detail, conversation)) => {
                let shown: Vec<String> = detail.turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect();
                for receipt in record_rows::turn_receipts(db, id, &shown)? {
                    if !detail.message_receipts.iter().any(|r| r.input.client_message_id == receipt.input.client_message_id) {
                        detail.message_receipts.push(receipt);
                    }
                }
                Ok(ConversationWindow { detail, conversation, stats })
            }
            Err(missing) => Err(missing),
        };
        Ok((found, fills))
    }

    /// Runs `read` on the Agent's metadata with one Turn with its payloads,
    /// or only one Item of it (`item`, in Turn `turn`, or in the newest Turn
    /// holding it), read in one snapshot. With a Turn ID that names a Turn
    /// without that Item, the Turn holds no Items. None if there is no such
    /// Agent.
    pub fn payload_view<T>(&self, id: &str, turn: Option<&str>, item: Option<&str>,
        read: impl FnOnce(&AgentDetail) -> T) -> Result<Option<T>> {
        self.settle_unwritten(id)?;
        let found = {
            // One snapshot: a read connection holds one until dropped.
            let db = self.db.read()?;
            let Some(mut meta) = record_rows::load_meta(&db, id)? else { return Ok(None) };
            let found = match (turn, item) {
                (_, Some(item)) => record_rows::load_item(&db, id, turn, item, true),
                (Some(turn), None) => record_rows::load_turn(&db, id, turn, true),
                (None, None) => Ok(None),
            }.inspect_err(|error| self.note_damage(id, error))?;
            meta.turns.extend(found);
            meta
        };
        Ok(Some(read(&found)))
    }

    /// One Agent as listed. A record is read only the first time it is
    /// listed after Core starts; every write keeps this view current.
    /// With its Project, as a whole record had it.
    pub fn agent(&self, id: &str) -> Result<Agent> {
        let mut agent = self.listed(id, Load::Reader)?.context("Agent 不存在")?.agent;
        agent.project_id = self.agent_project(id)?;
        Ok(agent)
    }

    /// Update safety checks use the same versioned view as Agent listing.
    pub(crate) fn update_readiness(&self, id: &str) -> Result<(Agent, Activity)> {
        let mut attempt = 0;
        loop {
            let lock = (attempt >= 2).then(|| self.record_lock(id));
            let _record = lock.as_ref().map(|lock| lock.lock());
            let version = self.memory.lock().unwrap().version(id);
            if version % 2 == 1 {
                attempt += 1;
                std::thread::yield_now();
                continue;
            }
            let listed = self.listed(id, Load::Reader)?.context("Agent 不存在")?;
            let memory = self.memory.lock().unwrap();
            ensure!(!memory.damaged.contains(id), "Cannot check update readiness: Agent {id} has damaged records; repair its storage before updating");
            if memory.version(id) == version {
                return Ok((listed.agent, listed.activity));
            }
            attempt += 1;
        }
    }

    /// `agent` when it needs no record read (it is listed, or hot).
    pub fn listed_agent(&self, id: &str) -> Option<Agent> {
        self.listed(id, Load::Never).ok().flatten().map(|listed| listed.agent)
    }

    /// `agent` for a caller already in a transaction (the collaboration
    /// paths). None if there is no such Agent.
    pub(crate) fn brief_in(&self, db: &Connection, id: &str) -> Result<Option<Brief>> {
        self.listed(id, Load::Through(db))
    }

    /// The Agent's listed view with its current rev: kept with every write,
    /// rebuilt from the hot slice when streamed events left it stale, and
    /// read from the rows (metadata, open and newest Turns) only the first
    /// time after Core starts.
    fn listed(&self, id: &str, load: Load) -> Result<Option<Brief>> {
        enum Source {
            Cached(Brief),
            Hot(Arc<RwLock<AgentDetail>>, u64, Unsettled),
            Row(u64),
        }
        let (source, rev) = {
            let memory = self.memory.lock().unwrap();
            let source = match memory.hot.get(id) {
                Some(hot) if hot.brief_stale || !memory.briefs.contains_key(id) => Source::Hot(hot.slice.clone(), hot.changes, hot.unsettled),
                _ => match memory.briefs.get(id) {
                    Some(brief) => Source::Cached(brief.clone()),
                    None => Source::Row(memory.version(id)),
                },
            };
            (source, memory.rev(id))
        };
        let listed = match source {
            Source::Cached(brief) => brief,
            Source::Hot(slice, changes, unsettled) => {
                let listed = brief_with(&slice.read(), unsettled);
                let mut guard = self.memory.lock().unwrap();
                let memory = &mut *guard;
                if let Some(hot) = memory.hot.get_mut(id).filter(|hot| Arc::ptr_eq(&hot.slice, &slice) && hot.changes == changes) {
                    hot.brief_stale = false;
                    memory.briefs.insert(id.into(), listed.clone());
                }
                listed
            }
            Source::Row(version) => {
                let (detail, current_view) = match load {
                    Load::Never => return Ok(None),
                    Load::Reader => (read_slice(&*self.db.read()?, id, &Sel::Open), true),
                    Load::Through(db) => (read_slice(db, id, &Sel::Open), !db.is_readonly(rusqlite::MAIN_DB).unwrap_or(true)),
                };
                let detail = match detail {
                    Ok(Some(detail)) => detail,
                    Ok(None) => return Ok(None),
                    Err(error) if error.downcast_ref::<Damaged>().is_some() => {
                        // Listed from its metadata, with why; never kept, so
                        // it is checked again when next listed.
                        self.note_damage(id, &error);
                        let meta = match load {
                            Load::Through(db) => record_rows::load_meta(db, id),
                            _ => record_rows::load_meta(&*self.db.read()?, id),
                        };
                        let Ok(Some(mut meta)) = meta else { return Err(error) };
                        meta.agent.status = "error".into();
                        meta.agent.error = Some(format!("{error:#}"));
                        let mut listed = brief(&meta);
                        listed.agent.rev = rev;
                        return Ok(Some(listed));
                    }
                    Err(error) => return Err(error),
                };
                let mut listed = brief(&detail);
                listed.agent.rev = rev;
                let mut guard = self.memory.lock().unwrap();
                let memory = &mut *guard;
                if current_view && version % 2 == 0 && memory.version(id) == version && !memory.hot.contains_key(id) {
                    memory.briefs.entry(id.into()).or_insert_with(|| listed.clone());
                }
                listed
            }
        };
        Ok(Some(listed))
    }

    /// Whether the Agent is closed, and the Codex thread it is bound to.
    pub fn binding(&self, id: &str) -> Result<(bool, Option<String>)> {
        if let Some(hot) = self.hot(id) {
            let d = hot.read();
            return Ok((d.agent.closed_at.is_some(), d.agent.thread_id.clone()));
        }
        let agent = self.listed(id, Load::Reader)?.context("Agent 不存在")?.agent;
        Ok((agent.closed_at.is_some(), agent.thread_id))
    }

    pub fn agents(&self) -> Result<Vec<Agent>> {
        let (ids, mut projects) = {
            let db = self.db.read()?;
            let mut statement = db.prepare("SELECT id FROM agents ORDER BY rowid")?;
            let ids = statement.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            (ids, crate::projects::agent_projects(&db)?)
        };
        let mut agents = Vec::with_capacity(ids.len());
        for id in ids {
            // None: deleted since the list was read.
            let Some(listed) = self.listed(&id, Load::Reader)? else { continue };
            let mut agent = listed.agent;
            agent.project_id = projects.remove(&id);
            agents.push(agent);
        }
        Ok(agents)
    }

    /// Candidate owners only. The responder still validates the live request
    /// and connection under the Agent's locks before recording or sending it.
    pub fn request_holders(&self, request_id: &str) -> Result<Vec<Agent>> {
        let mut holders = Vec::new();
        for agent in self.agents()? {
            if agent.closed_at.is_some() { continue; }
            if self.listed(&agent.id, Load::Reader)?.is_some_and(|b| b.pending_ids.iter().any(|id| id == request_id)) {
                holders.push(agent);
            }
        }
        Ok(holders)
    }

    /// The Agent's hot slice, read from its rows if it is not in memory, with
    /// room made for it. The caller holds the record lock.
    fn ensure_hot(&self, id: &str) -> Result<Arc<RwLock<AgentDetail>>> {
        if let Some(slice) = self.hot(id) {
            return Ok(slice);
        }
        self.ensure_undamaged(id)?;
        self.make_room(id, MAX_STREAMS - 1);
        let (mut slice, unsettled) = read_hot(&*self.db.read()?, id).inspect_err(|error| self.note_damage(id, error))?;
        let slice = {
            let mut memory = self.memory.lock().unwrap();
            slice.agent.rev = memory.rev(id);
            let hot = memory.hot.entry(id.into()).or_insert_with(|| Hot::new(std::mem::take(&mut slice), unsettled, Instant::now()));
            hot.slice.clone()
        };
        // Others streaming at the same moment may have filled the room.
        self.make_room(id, MAX_STREAMS);
        Ok(slice)
    }

    /// Puts into the hot slice the Turns of `turns` the Agent has and the
    /// slice lacks, each in its place. The caller holds the record lock.
    fn load_into(&self, id: &str, slice: &RwLock<AgentDetail>, turns: &[String]) -> Result<()> {
        let missing: Vec<String> = {
            let d = slice.read();
            turns.iter().filter(|t| !d.turns.iter().any(|have| have["id"] == t.as_str())).cloned().collect()
        };
        if missing.is_empty() {
            return Ok(());
        }
        let (loaded, have) = {
            let db = self.db.read()?;
            let loaded = held_turns(&db, id, &missing)?;
            let ids: Vec<String> = slice.read().turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect();
            (loaded, record_rows::turn_ords(&db, id, &ids)?)
        };
        let mut d = slice.write();
        for (ord, turn) in loaded {
            let at = d.turns.iter().position(|t| t["id"].as_str().and_then(|tid| have.get(tid)).is_none_or(|o| *o > ord));
            match at {
                Some(at) => d.turns.insert(at, turn),
                None => d.turns.push(turn),
            }
        }
        Ok(())
    }

    /// Puts back into the hot slice, whole, the Items of `named` (Turn,
    /// Item) a gap of its Turn holds, each in its stored place. The caller
    /// holds the record lock, and the slice's gaps are as written.
    fn load_named(&self, id: &str, slice: &RwLock<AgentDetail>, named: &[(String, String)]) -> Result<()> {
        let wanted: Vec<&(String, String)> = {
            let d = slice.read();
            named.iter().filter(|(turn, item)| d.turns.iter().find(|t| t["id"] == turn.as_str()).is_some_and(|t| {
                let items = t["items"].as_array().map(Vec::as_slice).unwrap_or_default();
                items.iter().any(|i| record_rows::gap_of(i).is_some()) && !items.iter().any(|i| i["id"] == item.as_str())
            })).collect()
        };
        for (turn, item) in wanted {
            let found = {
                let db = self.db.read()?;
                match record_rows::item_ord(&db, id, turn, item)? {
                    Some(ord) => record_rows::load_held_item(&db, id, turn, item)?.map(|value| (ord, value)),
                    None => None,
                }
            };
            let Some((ord, value)) = found else { continue };
            let mut d = slice.write();
            let Some(items) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str())
                .and_then(|t| t.get_mut("items")).and_then(Value::as_array_mut) else { continue };
            let Some(at) = items.iter().position(|i| record_rows::gap_of(i).is_some_and(|(from, count)| from <= ord && ord < from + count))
                else { continue };
            let (from, count) = record_rows::gap_of(&items[at]).unwrap();
            let mut parts = Vec::new();
            if ord > from {
                parts.push(record_rows::gap(from, ord - from));
            }
            parts.push(value);
            if ord + 1 < from + count {
                parts.push(record_rows::gap(ord + 1, from + count - ord - 1));
            }
            items.splice(at..=at, parts);
        }
        Ok(())
    }

    /// Replaces the hot slice's Turns that hold gaps by the Turns read whole
    /// from their rows (without payloads): after an event its gaps did not
    /// let through (`record_rows::GapConflict`). The caller holds the record
    /// lock and has written what streamed.
    fn fill_gaps(&self, id: &str, slice: &RwLock<AgentDetail>) -> Result<()> {
        let gapped: Vec<String> = slice.read().turns.iter()
            .filter(|t| t["items"].as_array().is_some_and(|items| items.iter().any(|i| record_rows::gap_of(i).is_some())))
            .filter_map(|t| t["id"].as_str().map(str::to_owned)).collect();
        if gapped.is_empty() {
            return Ok(());
        }
        let read = {
            let db = self.db.read()?;
            let mut read = record_rows::load_turns(&db, id, &gapped, false)?;
            for (_, turn) in &mut read {
                whole_in_progress(&db, id, turn)?;
            }
            read
        };
        let mut d = slice.write();
        for (_, turn) in read {
            if let Some(place) = d.turns.iter_mut().find(|t| t["id"] == turn["id"]) {
                *place = turn;
            }
        }
        Ok(())
    }

    /// The one place a streamed native event, Codex or Claude, reaches an
    /// Agent's hot Turns (see `apply_streamed`); `route` is the event's (see
    /// `route`). Evidence is journaled only, on the writer's unsynced
    /// connection; Ignored and Synchronous events are not handled here.
    ///
    /// A deferred event is journaled, applied and written with its journal
    /// row at once (unsynced). An ephemeral one is applied in memory and
    /// written by the next tick or write. Either is announced by the next
    /// tick, unless it changed what other parts of Core act on (`Watched`):
    /// then it is written at once with a synced commit, journaled if it was
    /// not yet, and `urgent` set so the caller announces it now.
    pub fn record_stream(&self, id: &str, route: Route, kind: &str, data: &Value) -> Result<Streamed> {
        let at = Utc::now();
        match route {
            Route::Synchronous | Route::Ignored => return Ok(Streamed::default()),
            Route::Evidence => {
                self.db.write()?.unsynced().execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,?2,?3,?4)",
                    params![id, kind, data.to_string(), at.to_rfc3339()])?;
                return Ok(Streamed::default());
            }
            Route::Deferred | Route::Ephemeral => {}
        }
        let lock = self.record_lock(id);
        let _record = lock.lock();
        let slice = self.ensure_hot(id)?;
        let gapped = slice.read().turns.iter()
            .any(|t| t["items"].as_array().is_some_and(|items| items.iter().any(|i| record_rows::gap_of(i).is_some())));
        // A Codex event names its Turn: no row is read to find it unless
        // the slice has gaps (each delta of a long stream comes here).
        let (turns, items) = if gapped || kind.starts_with("claude/") {
            let db = self.db.read()?;
            let turns = event_turns(&db, id, kind, data)?;
            (turns, if gapped { event_items(&db, id, kind, data)? } else { Vec::new() })
        } else {
            (named_turn(data), Vec::new())
        };
        self.load_into(id, &slice, &turns)?;
        self.load_named(id, &slice, &items)?;
        if route == Route::Ephemeral {
            return self.record_ephemeral(id, &slice, kind, data, at);
        }
        match self.record_deferred(id, &slice, kind, data, at) {
            Err(error) if error.downcast_ref::<record_rows::GapConflict>().is_some() => {
                // An Item the event reached was in a gap: applied once more
                // to its Turns read whole.
                self.write_unwritten(id)?;
                self.fill_gaps(id, &slice)?;
                self.record_deferred(id, &slice, kind, data, at)
            }
            done => done,
        }
    }

    /// `record_stream` of streamed output: applied to the hot slice in
    /// place, written by the next tick or write, unless it moved a field's
    /// start out of memory (written now) or changed what others act on.
    fn record_ephemeral(&self, id: &str, slice: &RwLock<AgentDetail>, kind: &str, data: &Value, at: DateTime<Utc>)
        -> Result<Streamed> {
        let now_instant = Instant::now();
        let applied = {
            let mut d = slice.write();
            let before = watched(&d);
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                apply_streamed(&mut d, None, kind, data, at);
                let dirty = Dirty::of_applied(&d, kind, data);
                let chunks = spill(&mut d, &dirty);
                (before != watched(&d), dirty, chunks)
            }))
        };
        let Ok((urgent, dirty, chunks)) = applied else {
            // A bug in applying it left the slice half-changed: it is
            // dropped and read again from the rows when next needed.
            let mut memory = self.memory.lock().unwrap();
            memory.hot.remove(id);
            memory.briefs.remove(id);
            bail!("Workspace 无法应用事件（{kind}）；Agent 的记录将从存储重读");
        };
        let spilled = !chunks.is_empty();
        let rev = {
            let mut memory = self.memory.lock().unwrap();
            let rev = memory.event(id, kind, data);
            if !urgent {
                memory.announce.insert(id.into());
            }
            if let Some(hot) = memory.hot.get_mut(id) {
                hot.unwritten.merge(dirty);
                hot.unwritten_since.get_or_insert(now_instant);
                hot.chunks.extend(chunks);
                hot.last = now_instant;
                hot.brief_stale = true;
                hot.changes += 1;
            }
            rev
        };
        slice.write().agent.rev = rev;
        if !urgent {
            if spilled {
                // A field's start left memory: its chunks are written now.
                if let Err(error) = self.write_unwritten(id) {
                    eprintln!("Workspace streamed output of Agent {id} not written yet: {error:#}");
                }
            }
            return Ok(Streamed { rev: Some(rev), urgent: false });
        }
        // Others act on it at once, so it must survive a crash like the
        // events that normally change it: journaled and written with one
        // synced commit. If that fails it stays in memory, written by the
        // tick.
        let pending = self.take_chunks(id);
        let written = (|| -> Result<(Rewrite<'_>, Unsettled)> {
            let dirty = self.memory.lock().unwrap().hot.get(id).map(|hot| hot.unwritten.clone()).unwrap_or_default();
            let (plan, mut agent) = {
                let d = slice.read();
                let db = self.db.read()?;
                (record_rows::plan(&db, id, &d, &d.turns, &[], &dirty, &[])?, d.agent.clone())
            };
            let mut db = self.db.write()?;
            let rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,?2,?3,?4)",
                params![id, kind, data.to_string(), at.to_rfc3339()])?;
            agent.last_seq = tx.last_insert_rowid();
            record_rows::apply(&tx, id, &plan, &agent)?;
            record_rows::write_chunks(&tx, id, &pending)?;
            let unsettled = Unsettled::read(&tx, id)?;
            tx.commit()?;
            let mut d = slice.write();
            d.agent.last_seq = agent.last_seq;
            settle_gaps(&mut d);
            Ok((rewrite, unsettled))
        })();
        let unsettled = match written {
            Ok((rewrite, unsettled)) => rewrite.done(|memory| {
                if let Some(hot) = memory.hot.get_mut(id) {
                    hot.unwritten = Dirty::default();
                    hot.unwritten_since = None;
                    hot.unsettled = unsettled;
                }
                unsettled
            }),
            Err(error) => {
                self.return_chunks(id, pending);
                eprintln!("Workspace record of Agent {id} not written yet: {error}");
                self.memory.lock().unwrap().hot.get(id).map(|hot| hot.unsettled).unwrap_or_default()
            }
        };
        let listed = brief_with(&slice.read(), unsettled);
        let mut memory = self.memory.lock().unwrap();
        if let Some(hot) = memory.hot.get_mut(id) {
            hot.brief_stale = false;
            hot.changes += 1;
        }
        memory.briefs.insert(id.into(), listed);
        Ok(Streamed { rev: Some(rev), urgent: true })
    }

    /// `record_stream` of completed content: applied to a copy of the hot
    /// slice and written with its journal row at once, so a write that fails
    /// leaves memory as it was and a retry never applies an event twice. The
    /// receipts of the user messages it reached are read and confirmed.
    fn record_deferred(&self, id: &str, slice: &RwLock<AgentDetail>, kind: &str, data: &Value, at: DateTime<Utc>)
        -> Result<Streamed> {
        let now_instant = Instant::now();
        let (mut staged, mut before) = {
            let d = slice.read();
            let mut staged = d.clone_meta();
            staged.turns = d.turns.clone();
            (staged, watched(&d))
        };
        let turns_before = kind.starts_with("claude/").then(|| staged.turns.clone());
        let spilled = spilled_fields(&staged);
        if crate::claude::confirms_text(kind) && !spilled.is_empty() {
            // Its chunks not written yet are part of the text too. A live
            // assistant frame confirms its own message only.
            let pending = self.memory.lock().unwrap().hot.get(id).map(|hot| hot.chunks.clone()).unwrap_or_default();
            let message = data["event"]["message"]["id"].as_str().unwrap_or_default();
            whole_messages(&*self.db.read()?, id, &mut staged, &pending, Some(message))?;
        }
        let applied = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            apply_streamed(&mut staged, None, kind, data, at);
        }));
        if applied.is_err() {
            bail!("Workspace 无法应用事件（{kind}）；此事件已跳过");
        }
        // A Claude event names its whole Turn: what it changed there is
        // found by comparing that Turn (one Turn, not the record).
        let changed = |staged: &AgentDetail| match &turns_before {
            Some(before) => Dirty::between(before, &staged.turns),
            None => Dirty::of_applied(staged, kind, data),
        };
        let mut dirty = changed(&staged);
        let clients = user_clients(&staged, &dirty);
        let mut receipts_before = Vec::new();
        if !clients.is_empty() {
            let db = self.db.read()?;
            for client in &clients {
                receipts_before.extend(record_rows::receipt(&db, id, client)?);
            }
        }
        if !receipts_before.is_empty() {
            staged.message_receipts = receipts_before.clone();
            staged.confirm_message_receipts();
            before.unconfirmed = receipts_before.iter().filter(|r| !matches!(r.status.as_str(), "accepted" | "rejected")).count();
            dirty.merge(changed(&staged));
        }
        drop(turns_before);
        let urgent = before != watched(&staged);
        // A spilled field the event set anew: its chunks are no part of it.
        let replaced = if spilled.is_empty() { Vec::new() } else {
            let db = self.db.read()?;
            let pending = |turn: &str, item: &str, field: &str| -> Vec<String> {
                self.memory.lock().unwrap().hot.get(id).map(|hot| hot.chunks.iter()
                    .filter(|c| c.turn == turn && c.item == item && c.field == field).map(|c| c.data.clone()).collect())
                    .unwrap_or_default()
            };
            replaced_fields(&mut staged, spilled, |turn, item, field, start|
                record_rows::chunks_are(&db, id, turn, item, field, start, &pending(turn, item, field)))?
        };
        // With what streamed output its rows still lack.
        let unwritten = self.memory.lock().unwrap().hot.get(id).map(|hot| hot.unwritten.clone()).unwrap_or_default();
        dirty.merge(unwritten);
        let fresh = spill(&mut staged, &dirty);
        staged.agent.pending_count = staged.pending.len() as u64;
        let plan = {
            let receipts = changed_receipts(&receipts_before, &staged.message_receipts);
            record_rows::plan(&*self.db.read()?, id, &staged, &staged.turns, &[], &dirty, &receipts)?
        };
        // Those of a replaced field are not written. The slice still notes
        // them until this write commits, so a failed one gives all back.
        let pending = self.take_chunks(id);
        let kept = |c: &&record_rows::Chunk| !replaced.iter().any(|(t, i, f)| *t == c.turn && *i == c.item && *f == c.field);
        let agent = &mut staged.agent;
        let written = (|| -> Result<(Rewrite<'_>, Unsettled)> {
            let mut db = self.db.write()?;
            let rewrite = self.rewrite(id);
            let tx = if urgent { db.transaction()? } else { db.unsynced().transaction()? };
            tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,?2,?3,?4)",
                params![id, kind, data.to_string(), at.to_rfc3339()])?;
            agent.last_seq = tx.last_insert_rowid();
            agent.unread_count = unread(&tx, id, agent.reviewed_seq)?;
            record_rows::apply(&tx, id, &plan, agent)?;
            for (turn, item, field) in &replaced {
                record_rows::drop_chunks(&tx, id, turn, item, field)?;
            }
            record_rows::write_chunks(&tx, id, pending.iter().filter(kept))?;
            record_rows::write_chunks(&tx, id, &fresh)?;
            let unsettled = Unsettled::read(&tx, id)?;
            tx.commit()?;
            Ok((rewrite, unsettled))
        })();
        drop(plan);
        let (rewrite, unsettled) = match written {
            Ok(written) => written,
            Err(error) => {
                self.return_chunks(id, pending);
                return Err(error);
            }
        };
        drop(fresh);
        drop(pending);
        settle_gaps(&mut staged);
        trim_hot(&mut staged, &dirty);
        let listed = brief_with(&staged, unsettled);
        let rev = rewrite.done(|memory| {
            let rev = memory.event(id, kind, data);
            let mut listed = listed;
            listed.agent.rev = rev;
            memory.briefs.insert(id.into(), listed);
            if !urgent {
                memory.announce.insert(id.into());
            }
            if let Some(hot) = memory.hot.get_mut(id) {
                hot.unwritten = Dirty::default();
                hot.unwritten_since = None;
                hot.unsettled = unsettled;
                hot.last = now_instant;
                hot.brief_stale = false;
                hot.changes += 1;
            }
            rev
        });
        staged.agent.rev = rev;
        *slice.write() = staged;
        Ok(Streamed { rev: Some(rev), urgent })
    }

    /// The streamed fields' starts an Agent's slice lost and its rows still
    /// lack, taken for a write (`return_chunks` if it fails).
    fn take_chunks(&self, id: &str) -> Vec<record_rows::Chunk> {
        self.memory.lock().unwrap().hot.get_mut(id).map(|hot| std::mem::take(&mut hot.chunks)).unwrap_or_default()
    }

    /// Chunks a failed write took, back before any cut since.
    fn return_chunks(&self, id: &str, mut chunks: Vec<record_rows::Chunk>) {
        if chunks.is_empty() {
            return;
        }
        match self.memory.lock().unwrap().hot.get_mut(id) {
            Some(hot) => {
                chunks.append(&mut hot.chunks);
                hot.chunks = chunks;
            }
            None => eprintln!("Workspace lost {} streamed chunks of Agent {id}: its slice was dropped", chunks.len()),
        }
    }

    /// Writes an active Agent's streamed output its rows lack, on the
    /// writer's unsynced connection (it need not be durable). The caller
    /// holds the record lock. A slice whose output cannot be placed in its
    /// rows (an Item a gap holds came again) is dropped: its rows are as
    /// last written.
    fn write_unwritten(&self, id: &str) -> Result<()> {
        let Some(slice) = self.hot(id) else { return Ok(()) };
        let dirty = match self.memory.lock().unwrap().hot.get(id) {
            Some(hot) if hot.unwritten_since.is_some() || !hot.chunks.is_empty() => hot.unwritten.clone(),
            _ => return Ok(()),
        };
        let pending = self.take_chunks(id);
        let written = (|| -> Result<Rewrite<'_>> {
            let (plan, agent) = {
                let d = slice.read();
                let db = self.db.read()?;
                (record_rows::plan(&db, id, &d, &d.turns, &[], &dirty, &[])?, d.agent.clone())
            };
            let mut db = self.db.write()?;
            let rewrite = self.rewrite(id);
            let tx = db.unsynced().transaction()?;
            record_rows::apply(&tx, id, &plan, &agent)?;
            record_rows::write_chunks(&tx, id, &pending)?;
            tx.commit()?;
            settle_gaps(&mut slice.write());
            Ok(rewrite)
        })();
        match written {
            Ok(rewrite) => {
                rewrite.done(|memory| {
                    if let Some(hot) = memory.hot.get_mut(id) {
                        hot.unwritten = Dirty::default();
                        hot.unwritten_since = None;
                    }
                });
                Ok(())
            }
            Err(error) => {
                if error.downcast_ref::<record_rows::GapConflict>().is_some() {
                    let mut memory = self.memory.lock().unwrap();
                    memory.hot.remove(id);
                    memory.briefs.remove(id);
                }
                self.return_chunks(id, pending);
                Err(error)
            }
        }
    }

    /// Drops an Agent's hot slice, keeping its brief current. The caller
    /// holds the record lock, and its streamed output is written.
    fn release(&self, id: &str) {
        let hot = self.memory.lock().unwrap().hot.get(id).map(|hot| (hot.slice.clone(), hot.brief_stale, hot.unsettled));
        let Some((slice, stale, unsettled)) = hot else { return };
        let listed = stale.then(|| brief_with(&slice.read(), unsettled));
        let mut memory = self.memory.lock().unwrap();
        memory.hot.remove(id);
        if let Some(listed) = listed {
            memory.briefs.insert(id.into(), listed);
        }
    }

    /// Makes the Agent active (its slice held, as an event does), for a test.
    #[cfg(test)]
    pub(crate) fn hold_for_test(&self, id: &str) -> Result<()> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        self.ensure_hot(id).map(drop)
    }

    #[cfg(test)]
    pub(crate) fn release_for_test(&self, id: &str) -> bool {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        let hot = self.hot(id).is_some();
        let _ = self.write_unwritten(id);
        self.release(id);
        hot
    }

    /// The hot slice, for a test outside this module.
    #[cfg(test)]
    pub(crate) fn held_for_test(&self, id: &str) -> Option<Arc<RwLock<AgentDetail>>> {
        self.hot(id)
    }

    /// Brings the Agents in memory down to `keep`, never dropping `except`:
    /// those written go first, then the least recently active, written and
    /// dropped. One being changed right now is passed over.
    fn make_room(&self, except: &str, keep: usize) {
        let candidates: Vec<String> = {
            let memory = self.memory.lock().unwrap();
            if memory.hot.len() <= keep {
                return;
            }
            let mut hot: Vec<_> = memory.hot.iter()
                .filter(|(id, _)| id.as_str() != except)
                .map(|(id, hot)| (hot.unwritten_since.is_some(), hot.last, id.clone()))
                .collect();
            hot.sort();
            hot.into_iter().map(|(_, _, id)| id).collect()
        };
        for id in candidates {
            if self.memory.lock().unwrap().hot.len() <= keep {
                return;
            }
            let lock = self.record_lock(&id);
            let Some(_record) = lock.try_lock() else { continue };
            if let Err(error) = self.write_unwritten(&id) {
                eprintln!("Workspace could not write Agent {id} to make room: {error}");
                return;
            }
            self.release(&id);
        }
    }

    /// Writes streamed output that has waited `write_after` and forgets idle
    /// Agents. Each Agent is written in its own transaction, and
    /// announcements and idle cleanup happen whatever the writes did.
    pub fn stream_tick(&self, write_after: Duration) -> Tick {
        self.tick(|hot| hot.unwritten_since.is_some_and(|since| since.elapsed() >= write_after))
    }

    /// Writes all streamed output only in memory: on close, and for a
    /// controlled restart.
    pub fn flush(&self) -> Tick {
        self.tick(|hot| hot.unwritten_since.is_some())
    }

    fn tick(&self, due: impl Fn(&Hot) -> bool) -> Tick {
        let due_now = |id: &str| self.memory.lock().unwrap().hot.get(id).is_some_and(&due);
        let candidates: Vec<String> = self.memory.lock().unwrap().hot.iter()
            .filter(|(_, hot)| due(hot)).map(|(id, _)| id.clone()).collect();
        let mut failed = Vec::new();
        for id in &candidates {
            let lock = self.record_lock(id);
            let _record = lock.lock();
            if !due_now(id) {
                continue;
            }
            if let Err(error) = self.write_unwritten(id) {
                failed.push(error.context(format!("Agent {id} 的记录未写入")));
            }
        }
        let idle = |hot: &Hot| hot.unwritten_since.is_none() && hot.last.elapsed() >= STREAM_IDLE;
        let candidates: Vec<String> = self.memory.lock().unwrap().hot.iter()
            .filter(|(_, hot)| idle(hot)).map(|(id, _)| id.clone()).collect();
        for id in &candidates {
            let lock = self.record_lock(id);
            let Some(_record) = lock.try_lock() else { continue };
            if self.memory.lock().unwrap().hot.get(id.as_str()).is_some_and(idle) {
                self.release(id);
            }
        }
        self.make_room("", MAX_STREAMS);
        self.records.lock().unwrap().retain(|_, lock| Arc::strong_count(lock) > 1);
        Tick { announce: self.memory.lock().unwrap().announce.drain().collect(), failed }
    }

    /// How many Agents are kept in memory (at most MAX_STREAMS while writes
    /// succeed).
    pub fn streamed_records(&self) -> usize {
        self.memory.lock().unwrap().hot.len()
    }

    /// The Agents kept in memory: each one's ID, its name, and whether it has
    /// streamed output its rows lack yet.
    pub fn held_agents(&self) -> Vec<HeldAgent> {
        let hot: Vec<_> = self.memory.lock().unwrap().hot.iter()
            .map(|(id, hot)| (id.clone(), hot.slice.clone(), hot.unwritten_since.is_some()))
            .collect();
        hot.into_iter()
            .map(|(id, slice, unwritten)| {
                let held = slice.try_read();
                HeldAgent { name: held.as_ref().map(|d| d.agent.name.clone()), bytes: held.as_ref().map(|d| slice_bytes(d)), id, unwritten }
            })
            .collect()
    }

    /// A change to an Agent, journaled as `kind` with `data`: `mutate` gets
    /// the Turns `sel` selects (see `Sel`) with the metadata and their
    /// receipts, and may change, add or remove any of them. Only what it
    /// changed is written (`Dirty::between` of those Turns), in one
    /// transaction with the journal row and the unread count. Until the
    /// commit, readers see the record as it was; if the write fails it stays
    /// so. `pick` gets the committed slice and its project; what it returns
    /// is returned with the change's rev.
    pub fn change<T>(&self, id: &str, kind: &str, data: &Value, sel: Sel, mutate: impl FnOnce(&mut AgentDetail),
        pick: impl FnOnce(&AgentDetail, Option<String>) -> T) -> Result<(u64, T)> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        self.change_locked(id, kind, data, sel, false, &[], mutate, pick)
    }

    /// The slice `sel` selects as it is now, for a change: from the rows,
    /// with the hot Turns (and metadata) in place of theirs where the Agent
    /// is in memory (they may hold streamed output the rows lack). The
    /// caller holds the record lock.
    fn slice_for_change(&self, id: &str, sel: &Sel) -> Result<AgentDetail> {
        self.ensure_undamaged(id)?;
        let hot = self.hot(id);
        // One snapshot: a read connection holds one until dropped.
        let db = self.db.read()?;
        let mut d = match &hot {
            Some(slice) => slice.read().clone_meta(),
            None => record_rows::load_meta(&db, id).inspect_err(|e| self.note_damage(id, e))?.context("Agent 不存在")?,
        };
        // Receipts are never held: those not settled are read for a change.
        d.message_receipts = record_rows::open_receipts(&db, id)?;
        if matches!(sel, Sel::Meta) {
            return Ok(d);
        }
        let mut ids = selected(&db, id, sel)?;
        // Those `Sel::Named` does not name are taken as the Agent holds them.
        let whole = match sel {
            Sel::Named(whole) => Some(whole),
            _ => None,
        };
        let held = |tid: &str| whole.is_some_and(|whole| !whole.iter().any(|w| w == tid));
        // The hot Turns as they are (their output is written), but those with
        // gaps, which a change gets whole from their rows unless it holds them.
        let hot_turns: Vec<Value> = hot.as_ref().map(|slice| slice.read().turns.iter()
            .filter(|t| held(t["id"].as_str().unwrap_or_default())
                || !t["items"].as_array().is_some_and(|items| items.iter().any(|i| record_rows::gap_of(i).is_some())))
            .cloned().collect()).unwrap_or_default();
        ids.retain(|tid| !hot_turns.iter().any(|t| t["id"] == tid.as_str()));
        let mut turns: Vec<(usize, Value)> = match whole {
            Some(whole) => read_named(&db, id, &ids, whole),
            None => record_rows::load_turns(&db, id, &ids, false),
        }.inspect_err(|e| self.note_damage(id, e))?;
        // Memory keeps what a change read (`change_locked`): an Item still in
        // progress comes whole, as an active Agent holds it, since streamed
        // output appends to it and a field's preview is not its value.
        for (_, turn) in &mut turns {
            whole_in_progress(&db, id, turn).inspect_err(|e| self.note_damage(id, e))?;
        }
        if !hot_turns.is_empty() {
            let names: Vec<String> = hot_turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect();
            let ords = record_rows::turn_ords(&db, id, &names)?;
            let mut next = usize::MAX / 2;
            for turn in hot_turns {
                // A hot Turn not written yet is the newest.
                let ord = turn["id"].as_str().and_then(|tid| ords.get(tid).copied()).unwrap_or_else(|| { next += 1; next });
                turns.push((ord, turn));
            }
            turns.sort_by_key(|(ord, _)| *ord);
        }
        d.turns = turns.into_iter().map(|(_, turn)| turn).collect();
        let names: Vec<String> = d.turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect();
        for receipt in record_rows::turn_receipts(&db, id, &names)? {
            if !d.message_receipts.iter().any(|r| r.input.client_message_id == receipt.input.client_message_id) {
                d.message_receipts.push(receipt);
            }
        }
        Ok(d)
    }

    /// `change`, for a caller holding the Agent's record lock. With
    /// `confirms`, receipts are accepted by the slice's user messages after
    /// the change (`confirm_message_receipts`).
    #[allow(clippy::too_many_arguments)]
    fn change_locked<T>(&self, id: &str, kind: &str, data: &Value, sel: Sel, confirms: bool, receipts: &[&str],
        mutate: impl FnOnce(&mut AgentDetail), pick: impl FnOnce(&AgentDetail, Option<String>) -> T) -> Result<(u64, T)> {
        // Streamed output its rows lack is written first: a change then
        // reads (and writes) only rows that hold all of it.
        self.write_unwritten(id)?;
        let mut d = self.slice_for_change(id, &sel)?;
        // The receipts the change names, settled or not.
        for client in receipts {
            if !d.message_receipts.iter().any(|r| r.input.client_message_id == *client) {
                if let Some(receipt) = record_rows::receipt(&*self.db.read()?, id, client)? {
                    d.message_receipts.push(receipt);
                }
            }
        }
        let loaded: Vec<String> = d.turns.iter().filter_map(|t| t["id"].as_str().map(str::to_owned)).collect();
        let turns_before = d.turns.clone();
        if crate::claude::confirms_text(kind) {
            // A backfill may confirm any saved message of the Turns it reads:
            // each is written whole below, its chunks dropped (the unwritten
            // ones were written above), and memory keeps it whole until it
            // leaves (an ended Item past HOT_ITEMS) or streams again.
            whole_messages(&*self.db.read()?, id, &mut d, &[], None)?;
        }
        let receipts_before = d.message_receipts.clone();
        mutate(&mut d);
        crate::message_content::bind(&mut d.turns, &mut d.message_receipts);
        if confirms {
            crate::model::accept_receipts(d.turns.iter(), &mut d.message_receipts);
        }
        d.agent.pending_count = d.pending.len() as u64;
        d.agent.updated_at = now();
        let mut dirty = Dirty::between(&turns_before, &d.turns);
        drop(turns_before);
        let unwritten = self.memory.lock().unwrap().hot.get(id).map(|hot| hot.unwritten.clone()).unwrap_or_default();
        dirty.merge(unwritten);
        let receipts = changed_receipts(&receipts_before, &d.message_receipts);
        let plan = record_rows::plan(&*self.db.read()?, id, &d, &d.turns, &loaded, &dirty, &receipts)?;
        drop(receipts);
        let rewrite;
        let (journaled, project_id) = {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            let journaled = if completed_before(&tx, id, kind, data)? { "turn/reconfirmed" } else { kind };
            tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,?2,?3,?4)",
                params![id, journaled, data.to_string(), now()])?;
            d.agent.last_seq = tx.last_insert_rowid();
            d.agent.unread_count = unread(&tx, id, d.agent.reviewed_seq)?;
            record_rows::apply(&tx, id, &plan, &d.agent)?;
            let project_id = crate::projects::agent_project(&tx, id)?;
            tx.commit()?;
            #[cfg(test)]
            AFTER_COMMIT.with(|hook| if let Some(hook) = hook.borrow_mut().as_mut() { hook() });
            #[cfg(test)]
            CHANGES.with(|n| n.set(n.get() + 1));
            (journaled, project_id)
        };
        drop(plan);
        // What memory keeps: the Agent's new metadata, and its open and
        // newest Turns where the slice has them. A change that read them
        // leaves the Agent active, as an event does.
        if self.hot(id).is_none() {
            self.make_room(id, MAX_STREAMS - 1);
            // A change of the metadata alone read no Turn: its slice is read
            // from the rows it just wrote. Nothing after the commit fails the
            // change: if that read does, the Agent is not held, and is read
            // again when next needed.
            let read = match sel {
                Sel::Meta => self.db.read().ok().and_then(|db| read_hot(&db, id).inspect_err(|e| self.note_damage(id, e)).ok())
                    .map(|(slice, _)| slice),
                _ => Some(d.clone_meta()),
            };
            if let Some(read) = read {
                let mut memory = self.memory.lock().unwrap();
                if !memory.hot.contains_key(id) {
                    memory.hot.insert(id.into(), Hot::new(read, Unsettled::default(), Instant::now()));
                }
            }
        }
        let hot = self.hot(id);
        let mut kept = match &hot {
            Some(slice) if matches!(sel, Sel::Meta) => {
                let mut kept = d.clone_meta();
                kept.turns = slice.read().turns.clone();
                Some(kept)
            }
            Some(_) => Some(d.clone()),
            None => None,
        };
        // The slice read every receipt not settled: what they say now.
        let unsettled = Unsettled::of(&d.message_receipts);
        if let Some(kept) = &mut kept {
            trim_hot(kept, &Dirty::all());
        }
        let listed = match &kept {
            Some(kept) => Some(brief_with(kept, unsettled)),
            None if !matches!(sel, Sel::Meta) => Some(brief(&d)),
            None => None,
        };
        let rev = rewrite.done(|memory| {
            let rev = memory.event(id, journaled, data);
            match listed {
                Some(mut listed) => {
                    listed.agent.rev = rev;
                    memory.briefs.insert(id.into(), listed);
                }
                None => {
                    memory.briefs.remove(id);
                }
            }
            if let Some(hot) = memory.hot.get_mut(id) {
                hot.unwritten = Dirty::default();
                hot.unwritten_since = None;
                hot.unsettled = unsettled;
                hot.last = Instant::now();
                hot.brief_stale = false;
                hot.changes += 1;
            }
            rev
        });
        d.agent.rev = rev;
        if let (Some(slice), Some(mut kept)) = (hot, kept) {
            kept.agent.rev = rev;
            *slice.write() = kept;
        }
        let picked = pick(&d, project_id);
        Ok((rev, picked))
    }

    /// `change` returning only the rev.
    pub fn record_event(&self, id: &str, kind: &str, data: &Value, sel: Sel, mutate: impl FnOnce(&mut AgentDetail)) -> Result<u64> {
        Ok(self.change(id, kind, data, sel, mutate, |_, _| ())?.0)
    }

    /// `record_event` of a change of the Turns an event names (see
    /// `event_turns`) and the open ones.
    pub fn record_event_turns(&self, id: &str, kind: &str, data: &Value, mutate: impl FnOnce(&mut AgentDetail)) -> Result<u64> {
        let named = self.named_turns(id, kind, data)?;
        self.record_event(id, kind, data, Sel::Turns(named), mutate)
    }

    /// The Turn holding the newest Item with this ID, if any.
    pub fn item_turn(&self, id: &str, item: &str) -> Result<Option<String>> {
        self.settle_unwritten(id)?;
        record_rows::item_turn(&*self.db.read()?, id, item)
    }

    /// The newest Turn whose object field `field` has this key (see
    /// `record_rows::turn_holding`).
    pub fn turn_holding(&self, id: &str, field: &str, key: &str) -> Result<Option<String>> {
        self.settle_unwritten(id)?;
        record_rows::turn_holding(&*self.db.read()?, id, field, key)
    }

    /// `change` returning only what `pick` takes from the committed slice.
    pub fn update_picking<T>(&self, id: &str, kind: &str, data: &Value, sel: Sel, mutate: impl FnOnce(&mut AgentDetail),
        pick: impl FnOnce(&AgentDetail) -> T) -> Result<T> {
        Ok(self.change(id, kind, data, sel, mutate, |d, _| pick(d))?.1)
    }

    /// A Claude `result` (claude.rs), `project` being its projection
    /// (`claude::project_event`): a change of the Turn it ends (with the
    /// open ones). `pick` gets the committed slice.
    pub fn update_picking_result<T>(&self, id: &str, kind: &str, data: &Value, project: impl Fn(&mut AgentDetail),
        pick: impl FnOnce(&AgentDetail) -> T) -> Result<T> {
        let named = self.named_turns(id, kind, data)?;
        Ok(self.change(id, kind, data, Sel::Turns(named), |d| project(d), |d, _| pick(d))?.1)
    }

    /// The Turns an event or a send names (see `event_turns`).
    fn named_turns(&self, id: &str, kind: &str, data: &Value) -> Result<Vec<String>> {
        event_turns(&*self.db.read()?, id, kind, data)
    }

    /// A Claude send's `turnRequested` or `message/bound` (claude.rs), which
    /// changes the Turn it names (`data.turnId`), appended when the record
    /// has none. Returns the change's rev.
    pub fn record_send(&self, id: &str, kind: &str, data: &Value, mutate: impl Fn(&mut AgentDetail)) -> Result<u64> {
        let named = self.named_turns(id, kind, data)?;
        self.record_event(id, kind, data, Sel::Turns(named), mutate)
    }

    /// `record_send` of a change made only where `shown`, reading the Turns
    /// that show the follow-up `client` (found by its key) and the one named,
    /// finds nothing: a Claude follow-up is shown once.
    pub fn record_send_unless(&self, id: &str, kind: &str, data: &Value, client: &str, shown: impl Fn(&[Value]) -> bool,
        mutate: impl Fn(&mut AgentDetail)) -> Result<u64> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        // Found under the record lock, so no other change moves the
        // follow-up between finding its Turn and this change.
        self.write_unwritten(id)?;
        let mut named = self.named_turns(id, kind, data)?;
        named.extend(self.keyed_turns_written(id, "client", Some(client))?);
        Ok(self.change_locked(id, kind, data, Sel::Turns(named), false, &[client], |d| if !shown(&d.turns[..]) { mutate(d) },
            |_, _| ())?.0)
    }

    /// A Claude `message_delivery` (`claude::deliver_message`), which shows
    /// the follow-up Claude named in the Turn it names (`data.turnId`), moved
    /// from the Turn showing it (found by its key). The slice has every open
    /// Turn, so `change` is told no other Turn is in progress.
    pub fn record_delivery(&self, id: &str, kind: &str, data: &Value, client_id: &str,
        change: impl Fn(&mut AgentDetail, bool)) -> Result<u64> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        // As in `record_send_unless`: found under the record lock.
        self.write_unwritten(id)?;
        let mut named = self.named_turns(id, kind, data)?;
        named.extend(self.keyed_turns_written(id, "client", Some(client_id))?);
        Ok(self.change_locked(id, kind, data, Sel::Turns(named), false, &[client_id], |d| change(d, false), |_, _| ())?.0)
    }

    /// A change to the record's metadata only: `mutate` gets no Turn (see
    /// `Meta`). Returns the change's rev.
    pub fn update_meta(&self, id: &str, kind: &str, data: &Value, mutate: impl FnOnce(&mut Meta<'_>)) -> Result<u64> {
        Ok(self.change(id, kind, data, Sel::Meta, |d| mutate(&mut Meta::of(d)), |_, _| ())?.0)
    }

    /// `update_meta` of a native event that `AgentDetail::apply` takes as a
    /// change to the metadata alone (`serverRequest/resolved`,
    /// `thread/status/changed`) or as no change at all, with `apply`'s last
    /// step too: each receipt not yet accepted or rejected is accepted by the
    /// first open or newest Turn with its user message.
    pub fn update_meta_applied(&self, id: &str, kind: &str, data: &Value, mutate: impl FnOnce(&mut Meta<'_>)) -> Result<u64> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        Ok(self.change_locked(id, kind, data, Sel::Open, true, &[], |d| mutate(&mut Meta::of(d)), |_, _| ())?.0)
    }

    /// `update_meta` for a change to the metadata that reads the open Turns
    /// without changing one: a Claude permission request, its cancellation
    /// and its resolution. `applies` decides from the open Turns whether this
    /// form fits (None: the caller commits otherwise).
    pub fn update_meta_by_turns(&self, id: &str, kind: &str, data: &Value, applies: impl FnOnce(&[Value]) -> bool,
        mutate: impl FnOnce(&[Value], &mut Meta<'_>)) -> Result<Option<u64>> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        let open = self.slice_for_change(id, &Sel::Open)?;
        if !applies(&open.turns) {
            return Ok(None);
        }
        Ok(Some(self.change_locked(id, kind, data, Sel::Open, false, &[], |d| {
            let turns = std::mem::take(&mut d.turns);
            mutate(&turns, &mut Meta::of(d));
            d.turns = turns;
        }, |_, _| ())?.0))
    }

    /// `update_picking` for a change to the metadata only.
    pub fn update_picking_meta<T>(&self, id: &str, kind: &str, data: &Value, mutate: impl FnOnce(&mut Meta<'_>),
        pick: impl FnOnce(&AgentDetail) -> T) -> Result<T> {
        Ok(self.change(id, kind, data, Sel::Meta, |d| mutate(&mut Meta::of(d)), |d, _| pick(d))?.1)
    }

    /// `update_picking_meta` of a change to the receipt of message `client`
    /// (and the metadata): the receipt is given to `mutate` settled or not.
    pub fn update_receipt_picking<T>(&self, id: &str, kind: &str, data: &Value, client: &str,
        mutate: impl FnOnce(&mut Meta<'_>), pick: impl FnOnce(&AgentDetail) -> T) -> Result<T> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        Ok(self.change_locked(id, kind, data, Sel::Meta, false, &[client], |d| mutate(&mut Meta::of(d)), |d, _| pick(d))?.1)
    }

    /// One native event that the record takes as `AgentDetail::apply(applied,
    /// data)` does, journaled as `kind` (`turn/accepted` applies the RPC
    /// response as `turn/started`): a change of the Turn it names and the
    /// open ones. Returns the change's rev.
    pub fn record_applied(&self, id: &str, kind: &str, applied: &str, data: &Value) -> Result<u64> {
        let named = self.named_turns(id, kind, data)?;
        // An event naming its Turn changes that Turn (and the Agent's fields):
        // the open and newest others are read as the Agent holds them, so a
        // Turn's start next to a long one does not read it whole. One naming
        // none gets them whole, as it may reach their Items.
        let sel = if named.is_empty() { Sel::Turns(named) } else { Sel::Named(named) };
        self.record_event(id, kind, data, sel, |d| d.apply(applied, data))
    }

    pub fn review(&self, id: &str, through: i64) -> Result<bool> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        // Already read (the usual case for an open conversation): decided from
        // the listed view, which every write keeps current.
        if let Some(listed) = self.memory.lock().unwrap().briefs.get(id) {
            if through.min(listed.agent.last_seq).max(listed.agent.reviewed_seq) == listed.agent.reviewed_seq {
                return Ok(false);
            }
        }
        self.ensure_undamaged(id)?;
        let hot = self.hot(id);
        let mut d = match &hot {
            Some(slice) => slice.read().clone_meta(),
            None => {
                let db = self.db.read()?;
                // A damaged record is not marked read: its rows are checked
                // (without parsing them) and its open Turns read first.
                let found = record_rows::rows_fit(&db, id).and_then(|fit| {
                    ensure!(fit, Damaged { agent: id.into(), cause: "its rows do not fit together".into() });
                    read_slice(&db, id, &Sel::Open)
                });
                match found {
                    Ok(found) => found.context("Agent 不存在")?.clone_meta(),
                    Err(error) => {
                        self.note_damage(id, &error);
                        return Err(error);
                    }
                }
            }
        };
        let reviewed = through.min(d.agent.last_seq).max(d.agent.reviewed_seq);
        if reviewed == d.agent.reviewed_seq { return Ok(false); }
        d.agent.reviewed_seq = reviewed;
        let body = record_rows::MetaBody::of(&d)?;
        let rewrite;
        {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            d.agent.unread_count = unread(&tx, id, reviewed)?;
            // Reading is not new conversation content: last_seq stays.
            tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'workspace/reviewed',?2,?3)",
                params![id,json!({"throughSeq":reviewed}).to_string(),now()])?;
            record_rows::write_meta(&tx, id, &body, &d.agent)?;
            tx.commit()?;
        }
        let unread_count = d.agent.unread_count;
        let rev = rewrite.done(|memory| {
            let rev = memory.changed(id);
            if let Some(listed) = memory.briefs.get_mut(id) {
                listed.agent.reviewed_seq = reviewed;
                listed.agent.unread_count = unread_count;
                listed.agent.rev = rev;
            }
            if let Some(hot) = memory.hot.get_mut(id) {
                hot.changes += 1;
            }
            rev
        });
        if let Some(slice) = hot {
            let mut s = slice.write();
            s.agent.reviewed_seq = reviewed;
            s.agent.unread_count = unread_count;
            s.agent.rev = rev;
        }
        Ok(true)
    }

    /// The Turns whose completion the journal has (or an import recorded).
    fn recorded_completions(&self, id: &str) -> Result<HashSet<String>> {
        let db = self.db.read()?;
        let mut query = db.prepare("SELECT json_extract(data,'$.turn.id') FROM journal
            WHERE agent_id=?1 AND kind='turn/completed' AND json_type(data,'$.turn.id')='text'
            UNION SELECT turn_id FROM codex_import_turns WHERE agent_id=?1")?;
        let ids = query.query_map([id], |row| row.get::<_, String>(0))?.collect::<rusqlite::Result<HashSet<_>>>()?;
        Ok(ids)
    }

    /// Whether `record_recovered_completions` would find a Turn to record.
    /// Reads only each Turn's id and status.
    pub fn has_unrecorded_completion(&self, id: &str, turns: &[Value]) -> Result<bool> {
        let known = self.recorded_completions(id)?;
        Ok(turns.iter().any(|turn| unrecorded_completion(turn, &known)))
    }

    /// The finished Turns among `turns` whose completion is not journaled,
    /// each journaled once (a reconnect found them finished).
    pub fn record_recovered_completions(&self, id: &str, turns: &[Value]) -> Result<()> {
        let known = self.recorded_completions(id)?;
        for turn in turns {
            if unrecorded_completion(turn, &known) {
                self.record_recovered_completion(id, turn)?;
            }
        }
        Ok(())
    }

    /// A reconnect can discover a completion without receiving its event.
    /// Journal it exactly once so unread/Catch-up work across disconnects
    /// too: its Turn's ID and status (all the journal's readers take).
    pub fn record_recovered_completion(&self, id: &str, turn: &Value) -> Result<()> {
        let exists: bool = self.db.read()?.query_row(COMPLETED, params![id, turn["id"].as_str()], |r| r.get(0))?;
        if exists { return Ok(()); }
        self.update_meta(id, "turn/completed", &json!({"turn":{"id":turn["id"],"status":turn["status"]},"recovered":true}), |_| {})?;
        Ok(())
    }

    pub fn has_error_since(&self, id: &str, seq: i64) -> Result<bool> {
        Ok(self.db.read()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM journal WHERE agent_id=?1 AND seq>?2 AND kind IN ('error','runtime/error'))",
            params![id, seq], |r| r.get(0))?)
    }

    /// Reads the Agent's hot slice (metadata, open and newest Turns) without
    /// copying it; None when it is not in memory. Under the slice's own read
    /// lock only, never `memory`.
    pub fn peek<T>(&self, id: &str, read: impl FnOnce(&AgentDetail) -> T) -> Option<T> {
        let slice = self.hot(id)?;
        let detail = slice.read();
        Some(read(&detail))
    }

    /// The Agent's current rev (see `Agent::rev`).
    pub fn rev(&self, id: &str) -> u64 {
        self.memory.lock().unwrap().rev(id)
    }

    /// What changed in the Agent's record after change `rev`.
    pub fn changed_items_since(&self, id: &str, rev: u64) -> Result<Changes> {
        let memory = self.memory.lock().unwrap();
        let Some(evidence) = memory.evidence.get(id) else {
            return Ok(Changes { newer: false, items: HashSet::new(), complete: true });
        };
        Ok(Changes {
            newer: evidence.event > rev,
            items: evidence.items.iter().filter(|(_, at)| **at > rev).map(|(item, _)| item.clone()).collect(),
            complete: rev >= evidence.floor,
        })
    }

    /// Reserve a replacement only for an explicitly known, never-used empty
    /// native thread. The caller must first confirm the exact native missing-
    /// rollout error. Recording the reservation before sending thread/start
    /// prevents retries if that new operation has an unknown outcome.
    pub fn begin_empty_thread_replacement(&self, id: &str, thread_id: &str) -> Result<bool> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        {
            let db = self.db.read()?;
            if db.query_row("SELECT EXISTS(SELECT 1 FROM codex_imports WHERE agent_id=?1)", [id], |r| r.get::<_,bool>(0))? {
                return Ok(false);
            }
            let detail = record_rows::load_meta(&db, id)?.context("Agent 不存在")?;
            if detail.agent.thread_id.as_deref() != Some(thread_id)
                || detail.agent.status == "uncertain"
                || record_rows::turn_count(&db, id)? > 0
                // A Turn whose write failed is only in memory.
                || self.peek(id, |held| !held.turns.is_empty()).unwrap_or(false)
                || !detail.pending.is_empty()
                || !detail.artifacts.is_empty()
                || detail.agent.last_message.is_some()
            {
                return Ok(false);
            }
            let mut query = db.prepare("SELECT kind,data FROM journal WHERE agent_id=?1 ORDER BY seq")?;
            let rows = query.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
            let mut protected_birth = false;
            let mut unsafe_operation = false;
            for row in rows {
                let (kind, data) = row?;
                let data: Value = serde_json::from_str(&data)?;
                if kind == "thread/attached" && data["threadId"] == thread_id && data["newEmptyThread"] == true
                    && data["turnRequestJournalVersion"] == 1 {
                    protected_birth = true;
                    unsafe_operation = false;
                    continue;
                }
                if protected_birth
                    && (kind.starts_with("turn/") || kind.starts_with("item/") || kind.starts_with("request")
                        || kind == "thread/replacementRequested" || kind == "codex/contextReload"
                        || data["outcomeUnknown"] == true)
                {
                    unsafe_operation = true;
                }
            }
            // Older versions had no durable turn/start intent. Lack of old events
            // cannot prove that a request was never sent before a process crash.
            if !protected_birth || unsafe_operation {
                return Ok(false);
            }
        }
        self.change_locked(id, "thread/replacementRequested", &json!({"oldThreadId":thread_id}), Sel::Meta, false, &[], |d| {
            d.agent.status = "uncertain".into();
            d.agent.error = Some("正在为未使用的 Agent 重建未落盘空会话；结果确认前不会重试。".into());
        }, |_, _| ())?;
        Ok(true)
    }

    pub fn catchup(&self) -> Result<Value> {
        let mut items = Vec::new();
        let mut from = i64::MAX;
        let mut to = 0;
        for a in self.agents()? {
            if a.closed_at.is_some() { continue; }
            from = from.min(a.reviewed_seq);
            to = to.max(a.last_seq);
            for p in &self.pending(&a.id)? {
                items.push(json!({"id":p.id,"agentId":a.id,"agentName":a.name,"kind":"pending","title":if p.stale {"上次请求需重新连接确认"} else {"需要你的回应"},"body":p.params["reason"].as_str().or_else(|| p.params["command"].as_str()).unwrap_or("打开对话查看完整请求"),"turnId":p.params["turnId"],"seq":a.last_seq}));
            }
            if let Some(error) = &a.error {
                items.push(json!({"id":format!("{}:error",a.id),"agentId":a.id,"agentName":a.name,"kind":"error","title":"执行需要检查","body":error,"seq":a.last_seq}));
            }
            // Bind results to *unread completed Turns*, not to unrelated unread
            // approvals or errors. A historical final is not a new result.
            for (seq, event) in self.unread_completions(&a.id, a.reviewed_seq)? {
                let id = &event["turn"]["id"];
                let Some(turn) = id.as_str().map(|tid| self.turn(&a.id, tid)).transpose()?.flatten() else {
                    continue;
                };
                let result = turn["items"].as_array().and_then(|items| {
                    items.iter().rev().find(|i| i["type"] == "agentMessage" && i["phase"] == "final_answer")
                });
                if let Some(item) = result {
                    let title = crate::rail::task(&turn).map_or_else(|| "本轮回复".into(), |s| s.text);
                    items.push(json!({"id":format!("{}:{}",a.id,item["id"]),"agentId":a.id,"agentName":a.name,"kind":"result","title":title,"body":item["text"],"turnId":turn["id"],"itemId":item["id"],"seq":seq}));
                } else {
                    items.push(json!({"id":format!("{}:{}",a.id,id),"agentId":a.id,"agentName":a.name,"kind":"progress","title":"Turn 已结束","body":"原生记录没有标注最终回复，请打开此 Turn 查看。","turnId":id,"seq":seq}));
                }
            }
            if a.status == "working" {
                if let Some(summary) = &a.work_summary {
                    items.push(json!({"id":format!("{}:progress",a.id),"agentId":a.id,"agentName":a.name,"kind":"progress","title":"仍在进行","body":summary.text,"turnId":summary.turn_id,"itemId":summary.item_id,"seq":a.last_seq}));
                }
            }
        }
        Ok(json!({"generatedAt":now(),"items":items,"source":"records","coverage":{"fromSeq":if from==i64::MAX {0}else{from},"toSeq":to}}))
    }

    fn unread_completions(&self, id: &str, reviewed: i64) -> Result<Vec<(i64, Value)>> {
        let db = self.db.read()?;
        let mut q = db.prepare("SELECT seq,data FROM journal WHERE agent_id=?1 AND seq>?2 AND kind='turn/completed' ORDER BY seq")?;
        let rows = q.query_map(params![id, reviewed], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        rows.map(|r| {
            let (seq, text) = r?;
            Ok((seq, serde_json::from_str(&text)?))
        }).collect()
    }
}

/// Whole-record access for tests and synthetic labs only (T-140): Core
/// itself never reads or changes a whole history, and nothing outside tests
/// and examples calls these.
#[doc(hidden)]
pub mod whole {
    use super::*;

    /// The whole record, with its payloads and every receipt.
    pub fn detail(store: &Store, id: &str) -> Result<AgentDetail> {
        store.settle_unwritten(id)?;
        let db = store.db.read()?;
        let mut d = record_rows::load_meta(&db, id)?.context("Agent 不存在")?;
        record_rows::scan(&db, id, true, |turn| { d.turns.push(turn); Ok(true) })?;
        record_rows::each_receipt(&db, id, |r| d.message_receipts.push(r))?;
        d.agent.rev = store.rev(id);
        d.agent.project_id = store.agent_project(id)?;
        crate::mailbox_notice::annotate(&db, &mut d)?;
        d.agent.work_summary = crate::rail::project(&d);
        Ok(d)
    }

    /// A change of every Turn (`Store::change` of `Sel::Tail` of all),
    /// returning the whole record after it.
    pub fn update(store: &Store, id: &str, kind: &str, data: &Value, mutate: impl FnOnce(&mut AgentDetail)) -> Result<AgentDetail> {
        store.record_event(id, kind, data, Sel::Tail(usize::MAX), mutate)?;
        detail(store, id)
    }

    /// `detail` and `update` as methods, for a test that imports this.
    pub trait WholeRecord {
        fn detail(&self, id: &str) -> Result<AgentDetail>;
        fn update(&self, id: &str, kind: &str, data: &Value, mutate: impl FnOnce(&mut AgentDetail)) -> Result<AgentDetail>;
    }

    impl WholeRecord for Store {
        fn detail(&self, id: &str) -> Result<AgentDetail> {
            detail(self, id)
        }
        fn update(&self, id: &str, kind: &str, data: &Value, mutate: impl FnOnce(&mut AgentDetail)) -> Result<AgentDetail> {
            update(self, id, kind, data, mutate)
        }
    }
}

/// How many whole records tests read of each Agent (`whole::detail`), by
/// the Store that read it. No production path reads one (T-140), so an
/// operation between two counts adds none of its own.
#[cfg(test)]
pub(crate) static DETAIL_READS_OF: std::sync::Mutex<Option<HashMap<(usize, String), u64>>> = std::sync::Mutex::new(None);

/// Every Store's whole reads of `id` in tests.
#[cfg(test)]
pub(crate) fn detail_reads_of(id: &str) -> u64 {
    DETAIL_READS_OF.lock().unwrap().as_ref()
        .map_or(0, |reads| reads.iter().filter(|((_, of), _)| of == id).map(|(_, n)| n).sum())
}

#[cfg(test)]
impl Store {
    /// `whole::detail`, for a test.
    pub(crate) fn detail(&self, id: &str) -> Result<AgentDetail> {
        *DETAIL_READS_OF.lock().unwrap().get_or_insert_with(HashMap::new)
            .entry((self as *const Self as usize, id.into())).or_default() += 1;
        whole::detail(self, id)
    }

    /// This Store's whole reads of `id` in tests (see `DETAIL_READS_OF`).
    pub(crate) fn detail_reads(&self, id: &str) -> u64 {
        DETAIL_READS_OF.lock().unwrap().as_ref()
            .and_then(|reads| reads.get(&(self as *const Self as usize, id.to_owned())).copied()).unwrap_or(0)
    }

    /// `whole::update`, for a test.
    pub(crate) fn update(&self, id: &str, kind: &str, data: &Value, mutate: impl FnOnce(&mut AgentDetail)) -> Result<AgentDetail> {
        whole::update(self, id, kind, data, mutate)
    }
}

/// A finished Turn whose completion is not among `known`.
fn unrecorded_completion(turn: &Value, known: &HashSet<String>) -> bool {
    matches!(turn["status"].as_str(), Some("completed" | "failed" | "interrupted"))
        && !turn["id"].as_str().is_some_and(|id| known.contains(id))
}

impl AgentDetail {
    /// The record without its Turns (its metadata and receipts), copied.
    pub(crate) fn clone_meta(&self) -> AgentDetail {
        let AgentDetail { agent, turns: _, history, pending, artifacts, context_usage, message_receipts, claude_runtime,
            codex_handoff } = self;
        AgentDetail {
            agent: agent.clone(),
            turns: Vec::new(),
            history: history.clone(),
            pending: pending.clone(),
            artifacts: artifacts.clone(),
            context_usage: context_usage.clone(),
            message_receipts: message_receipts.clone(),
            claude_runtime: claude_runtime.clone(),
            codex_handoff: codex_handoff.clone(),
        }
    }
}

impl Default for AgentDetail {
    fn default() -> Self {
        serde_json::from_value(json!({"agent":{"id":"","name":"","cwd":"","model":"","color":"","status":"",
            "createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[],"pending":[],"artifacts":[]})).expect("an empty record")
    }
}

#[cfg(test)]
#[path = "store/tests.rs"]
mod tests;
#[cfg(test)]
#[path = "store/window_tests.rs"]
mod window_tests;
#[cfg(test)]
#[path = "store/composition_tests.rs"]
mod composition_tests;
