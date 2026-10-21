use crate::model::{now, Agent, AgentDetail, MessageReceipt, PendingRequest};
use crate::record_rows::{self, Damaged, Dirty, Layout, Recovery};
use crate::remote::RemoteMachine;
use anyhow::{bail, ensure, Context, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use parking_lot::RwLock;
use std::{
    collections::{HashMap, HashSet},
    fs::{File, OpenOptions},
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// How long a journaled deferred event may stay only in memory (and in the
/// journal) before its Agent record is written. Rewriting the whole record
/// (often megabytes) for every event is what made long Turns fall behind.
/// Readers use the copy in memory and the journal makes events durable, so
/// this only bounds how much journal a load replays after a crash. Each
/// write of a 6 MB record costs ~0.13 s in the debug build (almost all of it
/// serializing); at 3 s these writes were most of Core's CPU and all of its
/// disk writes with three Agents streaming at a realistic pace.
pub const STREAM_WRITE_AFTER: Duration = Duration::from_secs(10);
/// A held record nobody has added to for this long is dropped from memory.
const STREAM_IDLE: Duration = Duration::from_secs(5);
/// At most this many parsed records are held at once.
pub const MAX_STREAMS: usize = 8;

/// How a native event reaches its Agent's record. Decided once per event by
/// `route` and passed through.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// Journaled and written with its record at once, as every event was
    /// before T-9: Turn boundaries, request resolution, errors, status,
    /// compaction, the session's start and its reported mode, MCP server
    /// connection status (`synchronous`).
    Synchronous,
    /// Journaled at once and applied to the record held in memory, which
    /// every reader uses; the record is written on the stream cadence or with
    /// the next synchronous event. Completed content (Codex Items starting
    /// and finishing, Claude assistant messages, tool results and sub-agent
    /// task events), plan and token usage, Claude rate limits, and any
    /// future kind `apply` or `project_event` acts on.
    Deferred,
    /// Streaming output (`streaming`): applied to the record held in memory
    /// and announced, never journaled and never the reason for a write. The
    /// completed form of the same content is journaled and replaces it, as
    /// Codex rollouts, opencode and the OpenHands SDK treat deltas. A record
    /// may still be written with partial text (with a journaled change, to
    /// make room, or on close), but nothing depends on it: after a crash an
    /// Item still streaming may lose its partial text, completed content
    /// never does.
    Ephemeral,
    /// Journaled as native evidence only, because nothing in the record
    /// changes for it (`AgentDetail::acts_on`, `claude::acts_on`): Codex
    /// hooks, rate limits, automatic approval reviews and their notice,
    /// warnings, terminal interaction; Claude status and hook notices, the
    /// background task list, tool heartbeats, command lifecycle; kinds Core
    /// does not know yet. A journal row costs a small insert; the raw
    /// evidence (which hooks ran, what an automatic review decided) stays for
    /// audit, and the record is neither loaded nor written for it. Journal
    /// replay skips these too.
    Evidence,
    /// Streaming output nothing in the record changes for (Codex
    /// `turn/diff/updated`, deltas of Item kinds `apply` keeps no text for;
    /// Claude thinking-token counts and a subagent's partial stream): dropped.
    Ignored,
}

/// The route of one native event (Codex method and params, or `claude/` and
/// the SDK event type with the whole bridge message). Only a short list
/// stays synchronous, so a kind Core does not know yet never makes it
/// rewrite a whole record. None of the other routes is ever counted as
/// unread (turn/completed, request, runtime/error). Should a streamed event
/// still change what other parts of Core act on (a Claude session mismatch,
/// an Item for a Turn never started), it is journaled, written and announced
/// at once anyway (see `Watched`). Kinds Core records itself never come here.
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

/// Where every streamed native event, Codex or Claude, is applied to a
/// record: live (`Store::record_stream`) and when a record is rebuilt from
/// its journal (`restore`). `at` is the event's journal time (now, for an
/// ephemeral one); nothing here reads the clock, so a rebuilt record is the
/// record readers saw.
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

/// A journal row's time, as written by `record_stream`.
fn journal_time(at: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(at).map_or_else(|_| Utc::now(), |at| at.with_timezone(&Utc))
}

/// What other parts of Core act on as soon as it changes: status and error,
/// requests, Turn boundaries, unconfirmed messages, the connection and the
/// native identity. Doorbells, Catch-up, collaboration and the rail follow
/// these. Streamed events normally leave all of it alone; one that does not
/// is announced at once, and written at once if it is journaled.
#[derive(PartialEq)]
struct Watched {
    status: String,
    error: Option<String>,
    connection: String,
    closed: bool,
    session: Option<String>,
    thread: Option<String>,
    pending: usize,
    turns: usize,
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
        turns: d.turns.len(),
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
/// Kept with the listed view, including streamed changes and journal replay.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct Activity {
    pub pending: bool,
    pub sending: bool,
    pub uncertain: bool,
    pub running: bool,
}

impl Activity {
    pub(crate) fn of(detail: &AgentDetail) -> Self {
        Self {
            pending: detail.pending.iter().any(|p| !p.stale),
            sending: detail.message_receipts.iter().any(|r| r.status == "sending"),
            uncertain: detail.message_receipts.iter().any(|r| r.status == "uncertain"),
            // An in-progress Turn without an ID still blocks an update.
            running: detail.turns.iter().any(|t| t["status"] == "inProgress"),
        }
    }
}

fn send_view_of(d: &AgentDetail) -> AgentDetail {
    AgentDetail {
        agent: d.agent.clone(),
        turns: d.turns.iter().map(send_turn).collect(),
        history: d.history.clone(),
        pending: d.pending.clone(),
        artifacts: Vec::new(),
        context_usage: d.context_usage.clone(),
        message_receipts: d.message_receipts.clone(),
        claude_runtime: d.claude_runtime.clone(),
        codex_handoff: d.codex_handoff.clone(),
    }
}

/// A Turn for `Store::send_view`: everything but its Items, of which only the
/// async questions remain (what an answer to one is checked against).
fn send_turn(turn: &Value) -> Value {
    let Some(fields) = turn.as_object() else { return turn.clone() };
    let mut light: serde_json::Map<String, Value> = fields.iter()
        .filter(|(key, _)| key.as_str() != "items").map(|(k, v)| (k.clone(), v.clone())).collect();
    if let Some(items) = fields.get("items").and_then(Value::as_array) {
        light.insert("items".into(), items.iter().filter(|i| i["delivery"] == "async").cloned().collect());
    }
    light.into()
}

/// A finished Turn whose completion is not among `known` (see
/// `Store::record_recovered_completions`).
fn unrecorded_completion(turn: &Value, known: &HashSet<String>) -> bool {
    matches!(turn["status"].as_str(), Some("completed" | "failed" | "interrupted"))
        && !turn["id"].as_str().is_some_and(|id| known.contains(id))
}

/// The part of a record outside its Turns that a change through
/// `Store::update_meta` may make: no Turn can be reached from it, so what such
/// a change wrote need not be found by comparing the whole record.
pub struct Meta<'a> {
    pub agent: &'a mut Agent,
    pub message_receipts: &'a mut Vec<MessageReceipt>,
    /// Pending native requests are metadata too: a request arriving, its
    /// answer and its replay change them and the Agent's status only.
    pub pending: &'a mut Vec<PendingRequest>,
}

impl<'a> Meta<'a> {
    fn of(detail: &'a mut AgentDetail) -> Self {
        Self { agent: &mut detail.agent, message_receipts: &mut detail.message_receipts, pending: &mut detail.pending }
    }
}

/// How `Store::commit` finds what a change wrote.
enum Scope<'a> {
    /// By comparing the record before and after (`Dirty::between`).
    Compare,
    /// The metadata (the change got a `Meta`).
    Meta,
    /// One native event of this kind applied by `AgentDetail::apply`.
    Applied(&'a str),
}

/// What a change in `scope` wrote, named without comparing the whole record:
/// what the scope names, and the Items `message_content::restore` changed
/// meanwhile (its own and those of the `bind` after it). None to compare
/// instead: `Scope::Compare`, or Turns `after` the change that cannot be
/// told apart by ID (see `Dirty::identified`).
fn scoped(scope: &Scope<'_>, after: &AgentDetail, data: &Value, restored: Vec<crate::message_content::Restored>) -> Option<Dirty> {
    let mut dirty = match scope {
        Scope::Compare => return None,
        Scope::Meta => Dirty::default(),
        Scope::Applied(kind) => Dirty::of_applied(after, kind, data),
    };
    for (turn, item, renamed) in restored {
        if renamed {
            dirty.whole_turn(&turn);
        } else {
            dirty.item(&turn, &item);
        }
    }
    dirty.identified(after)
}

/// The record without its Turns: what `Store::commit_meta` changes.
fn meta_of(detail: &AgentDetail) -> AgentDetail {
    let AgentDetail { agent, turns: _, history, pending, artifacts, context_usage, message_receipts, claude_runtime, codex_handoff } = detail;
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

/// `meta`'s metadata (see `meta_of`) on `detail`, whose Turns are kept.
fn put_meta(detail: &mut AgentDetail, meta: AgentDetail) {
    let AgentDetail { agent, turns: _, history, pending, artifacts, context_usage, message_receipts, claude_runtime, codex_handoff } = meta;
    detail.agent = agent;
    detail.history = history;
    detail.pending = pending;
    detail.artifacts = artifacts;
    detail.context_usage = context_usage;
    detail.message_receipts = message_receipts;
    detail.claude_runtime = claude_runtime;
    detail.codex_handoff = codex_handoff;
}

fn brief(detail: &AgentDetail) -> Brief {
    let mut agent = detail.agent.clone();
    agent.work_summary = crate::rail::project(detail);
    agent.project_id = None;
    let active = detail.turns.iter().rev().find(|t| t["status"] == "inProgress");
    let active_turn = active.and_then(|t| t["id"].as_str()).map(str::to_owned);
    let active_turn_unmatched = active.is_some_and(|t| t["_yuzunoUnmatched"] == true);
    let pending_ids = detail.pending.iter().map(|p| p.id.clone()).collect();
    Brief { agent, active_turn, active_turn_unmatched, pending_ids, activity: Activity::of(detail) }
}

/// A parsed record held in memory while its Agent streams, and for a while
/// after each write, so the next event or update need not load it. The
/// record has its own lock, so copying it for a reader or serializing it for
/// a write never holds `Store::memory`, the lock every Agent's events share.
struct Held {
    detail: Arc<RwLock<AgentDetail>>,
    /// What its rows lack (see `record_rows::plan`): changes since it was
    /// last written, and those replaying its journal made when it was loaded.
    unwritten: Dirty,
    /// Since when it has journaled changes its row lacks; None once written.
    unwritten_since: Option<Instant>,
    /// It has ephemeral output its row lacks. That alone never makes it due
    /// for writing, but it is not dropped without being written, so streamed
    /// text does not vanish from view mid-Item.
    ephemeral: bool,
    /// When an event last reached it.
    last: Instant,
    /// Streamed events only mark the brief; it is rebuilt when read.
    brief_stale: bool,
    /// Counts changes to `detail`: a brief rebuilt from it outside `memory`
    /// is kept only if no change came in meanwhile.
    changes: u64,
}

impl Held {
    fn new(detail: AgentDetail, unwritten: Dirty, now: Instant) -> Self {
        Self {
            detail: Arc::new(RwLock::new(detail)),
            unwritten,
            unwritten_since: None,
            ephemeral: false,
            last: now,
            brief_stale: false,
            changes: 0,
        }
    }

    /// Its row lacks something it has.
    fn dirty(&self) -> bool {
        self.unwritten_since.is_some() || self.ephemeral
    }
}

/// At most this many Items' last change is kept per Agent for
/// `changed_items_since`; the oldest go first.
const ITEM_EVIDENCE: usize = 256;

/// Which changes reached an Agent's record in this Core process, by rev, so
/// a native snapshot requested at some rev is not taken for newer than them.
/// Kept apart from held records, so it survives release, eviction and a
/// failed write.
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
/// bookkeeping: never across SQLite, a record's (de)serialization or copy,
/// or while waiting for another lock.
struct Memory {
    held: HashMap<String, Held>,
    briefs: HashMap<String, Brief>,
    /// Agents with progress not announced yet. Kept apart from `held`, so an
    /// evicted record is still announced.
    announce: HashSet<String>,
    /// Each Agent's row version, a sequence lock: odd while a write of its
    /// rows is being committed (`Store::rewrite`), even otherwise, and the
    /// rev of a committed change becomes visible with the even bump. A
    /// reader that saw the same even version before and after its snapshot
    /// knows the snapshot holds exactly the changes up to the rev it read
    /// with it (`Store::current`), and that a brief built from it may be kept
    /// (`Store::listed`).
    versions: HashMap<String, u64>,
    /// The change counter of this Core process (see `Agent::rev`), and the
    /// last value each Agent's record took.
    last_rev: u64,
    revs: HashMap<String, u64>,
    evidence: HashMap<String, Evidence>,
    /// Agents whose record was found damaged in this process (shown as a
    /// stand-in, or a change refused): no change is made to them, read
    /// marks included (`Store::review`).
    damaged: HashSet<String>,
}

impl Memory {
    /// Turns the Agent's version odd (a write is about to commit) or even
    /// again (it committed or failed); see `versions`.
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
/// shows it (see `Memory::versions`). Created under the Agent's record lock.
/// Dropped without `done` (the write failed and rolled back), it only makes
/// the version even again.
struct Rewrite<'a> {
    store: &'a Store,
    id: &'a str,
    done: bool,
}

impl Rewrite<'_> {
    /// The write committed: the version turns even, and whatever `show`
    /// does (the change's rev, its brief) becomes visible with it.
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
    /// Runs on this thread right after `commit` commits (tests pause there).
    static AFTER_COMMIT: std::cell::RefCell<Option<Box<dyn FnMut()>>> = const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
thread_local! {
    /// How many changes `Store::commit_meta` got to writing on this thread
    /// without copying the Turns.
    pub(super) static META_IN_PLACE: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// Signals when `commit` has planned (serialized) the write of the watched
/// Agent's record, before it takes the writer. A test holds the writer then.
#[cfg(test)]
static AFTER_PLAN: std::sync::Mutex<Option<(String, std::sync::mpsc::Sender<()>)>> = std::sync::Mutex::new(None);

/// What one stream tick did.
pub struct Tick {
    /// Agents with streamed events since the previous tick, to announce once
    /// rather than per event.
    pub announce: Vec<String>,
    /// Record writes that failed. Those records stay held and pending, and
    /// are tried again on the next tick.
    pub failed: Vec<anyhow::Error>,
}

/// How `Store::listed` may read a record it has to parse.
#[derive(Clone, Copy)]
enum Load<'a> {
    /// A new reader.
    Reader,
    /// The caller's open transaction.
    Through(&'a Connection),
    /// It may not: only a listed or held Agent is answered.
    Never,
}

/// Store's locks, outermost first:
///
/// 1. An Agent's record lock (`records`): held by whatever changes that
///    Agent's row, journal or held copy, from reading it until memory shows
///    the commit. Changes to one Agent are serialized by it; nothing else
///    waits for it (other Agents, readers, the ticker for other records).
///    `make_room` and idle cleanup only *try* another Agent's.
/// 2. At most one database connection: the writer (only for the statements
///    and commit, never for parsing or serializing a record) or a reader.
/// 3. `memory`, or a held record's own lock, never both at once and never
///    while waiting for anything else.
pub struct Store {
    pub(crate) db: crate::db::Db,
    /// Held records, briefs, revisions and evidence (see `Memory`).
    memory: Mutex<Memory>,
    records: Mutex<HashMap<String, Arc<parking_lot::Mutex<()>>>>,
    // Keep the OS lock alive until SQLite is closed. A second Core must not mark
    // the first Core's running agents offline merely because it uses another port.
    // It also keeps older Cores out while they would mishandle this Workspace.
    pub(crate) workspace_lock: crate::older_cores::Guard,
}

impl Drop for Store {
    fn drop(&mut self) {
        // After a panic while writing, memory may be half-changed: leave the
        // records to their journals rather than write it (or panic again).
        if self.memory.is_poisoned() {
            return;
        }
        // Deferred events still only in memory are written before closing,
        // and ephemeral output with them.
        for error in self.flush().failed {
            eprintln!("Workspace streamed output not written on close: {error:#}");
        }
    }
}

/// Unfinished Jobs that run on a machine: remote Jobs record it as
/// `executor.machineId` (T-108); local ones have none.
fn machine_jobs(db: &Connection, id: &str) -> Result<i64> {
    Ok(db.query_row(
        "SELECT COUNT(*) FROM local_jobs WHERE (reserved=1 OR status IN ('queued','waiting'))
         AND json_extract(data,'$.executor.machineId')=?1", [id], |r| r.get(0))?)
}

fn unread(db: &Connection, id: &str, reviewed: i64) -> Result<u64> {
    Ok(db.query_row("SELECT COUNT(*) FROM journal WHERE agent_id=?1 AND seq>?2 AND kind IN ('turn/completed','request','runtime/error')",
        params![id, reviewed], |r| r.get::<_, i64>(0))? as u64)
}

/// A record to change: with everything its journal says it already
/// contains, and what replaying that changed (its rows lack it). Read in the
/// caller's snapshot. A damaged record (see `record_rows::Damaged`) is not
/// changed: the error says how to recover it.
fn load(db: &Connection, id: &str) -> Result<(AgentDetail, Dirty)> {
    match record_rows::load(db, id, true) {
        Ok(Some(mut detail)) => {
            let replayed = restore(db, id, &mut detail)?;
            Ok((detail, replayed))
        }
        Ok(None) => bail!("Agent 不存在"),
        Err(error) => match error.downcast::<Damaged>() {
            // Still a `Damaged` underneath (see `Store::list_damaged`).
            Ok(damage) => {
                let note = damage_note(db, &damage, None);
                Err(anyhow::Error::new(damage).context(note))
            }
            Err(error) => Err(error),
        },
    }
}

/// A record as readers are shown it, and whether it is a damaged record's
/// stand-in (see `stand_in`).
struct Shown {
    detail: AgentDetail,
    damaged: bool,
}

/// Whether a journal row is replayed onto the record it belongs to (see
/// `restore`): read marks, and deferred or ephemeral native events.
fn replayed(kind: &str, data: &Value) -> bool {
    kind == "workspace/reviewed" || matches!(route(kind, data), Route::Deferred | Route::Ephemeral)
}

/// A record for readers, in the caller's snapshot: with or without payloads
/// (`record_rows::load`; Items a pending request refers to always with
/// theirs), and with what its journal adds. A damaged record is stood in for
/// (see `stand_in`). None if there is no such Agent.
fn read_record(db: &Connection, id: &str, payloads: bool) -> Result<Option<Shown>> {
    match record_rows::read(db, id, payloads)? {
        None => Ok(None),
        Some(stored) => finish(db, id, record_rows::assemble_stored(id, stored, payloads), payloads).map(Some),
    }
}

/// A damaged record's stand-in, for readers.
fn shown_damaged(db: &Connection, id: &str, error: anyhow::Error) -> Result<Shown> {
    let damage = error.downcast::<Damaged>()?;
    Ok(Shown { detail: stand_in(db, id, &damage)?, damaged: true })
}

/// What an Agent's listed view is built from (see `record_rows::load_recent`),
/// with what its journal adds, in the caller's snapshot: cheap enough to
/// read through the writer's transaction. A damaged record is stood in for.
fn read_recent(db: &Connection, id: &str) -> Result<Option<Shown>> {
    match record_rows::load_recent(db, id) {
        Ok(Some(mut detail)) => {
            restore(db, id, &mut detail)?;
            Ok(Some(Shown { detail, damaged: false }))
        }
        Ok(None) => Ok(None),
        Err(error) => shown_damaged(db, id, error).map(Some),
    }
}

/// `read_record` from a record assembled in the same snapshot: replays its
/// journal, and stands in for it if it is damaged (also when an Item a
/// pending request refers to cannot be read whole).
fn finish(db: &Connection, id: &str, assembled: Result<AgentDetail>, payloads: bool) -> Result<Shown> {
    let mut detail = match assembled {
        Ok(detail) => detail,
        Err(error) => return shown_damaged(db, id, error),
    };
    let replayed = restore(db, id, &mut detail)?;
    if !payloads {
        if !replayed.is_meta_only() {
            // Replayed events may have changed Items only previews are here of.
            return read_record(db, id, true)?.context("Agent 不存在");
        }
        if let Err(error) = whole_referenced(db, id, &mut detail) {
            return shown_damaged(db, id, error);
        }
    }
    Ok(Shown { detail, damaged: false })
}

/// Items a pending request refers to, made whole: clients are sent them
/// whole (see `client_view::referenced`).
fn whole_referenced(db: &Connection, id: &str, detail: &mut AgentDetail) -> Result<()> {
    let wanted: HashSet<String> = crate::client_view::referenced(&detail.pending).into_iter().map(str::to_owned).collect();
    if wanted.is_empty() {
        return Ok(());
    }
    for turn in &mut detail.turns {
        let turn_id = turn["id"].as_str().map(str::to_owned);
        for item in turn.get_mut("items").and_then(Value::as_array_mut).into_iter().flatten() {
            let Some(item_id) = item["id"].as_str().filter(|id| wanted.contains(*id)) else { continue };
            if item.get(record_rows::TRUNCATED).is_none() {
                continue;
            }
            let found = record_rows::load_item(db, id, turn_id.as_deref(), item_id, true)?;
            if let Some(whole) = found.and_then(|mut turn| turn["items"].as_array_mut().and_then(|items| items.pop())) {
                *item = whole;
            }
        }
    }
    Ok(())
}

/// What a damaged record is shown as, read only: its whole row from before
/// the conversion with what the journal replays since, else its metadata
/// without Turns. None if neither can be read.
pub(crate) fn recover(db: &Connection, id: &str) -> Result<Option<(AgentDetail, Recovery)>> {
    if let Some((data, converted_at)) = record_rows::original(db, id)? {
        if let Ok(mut detail) = serde_json::from_str::<AgentDetail>(&data) {
            restore(db, id, &mut detail)?;
            return Ok(Some((detail, Recovery::Original { converted_at })));
        }
    }
    match record_rows::load_meta(db, id) {
        Ok(detail) => Ok(detail.map(|detail| (detail, Recovery::WithoutTurns))),
        Err(error) if error.is::<Damaged>() => Ok(None),
        Err(error) => Err(error),
    }
}

/// A damaged record as readers see it (see `recover`): marked with what
/// happened and how to recover; an Agent with nothing but its ID if nothing
/// of it can be read. Only this Agent is affected.
fn stand_in(db: &Connection, id: &str, damage: &Damaged) -> Result<AgentDetail> {
    let recovered = recover(db, id)?;
    let note = damage_note(db, damage, recovered.as_ref().map(|(_, how)| how));
    let mut detail = match recovered {
        Some((detail, _)) => detail,
        None => serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"","model":"","color":"sage",
            "status":"error","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,"lastSeq":0,
            "reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))?,
    };
    detail.agent.status = "error".into();
    detail.agent.error = Some(note);
    Ok(detail)
}

/// What a damaged record's Agent says, and how to recover it.
fn damage_note(db: &Connection, damage: &Damaged, shown: Option<&Recovery>) -> String {
    let shown = match shown {
        Some(Recovery::Original { converted_at }) => format!(
            "现在显示的是转换时（{converted_at}）的记录加上日志重放，之后的部分变更可能缺失。"),
        Some(Recovery::WithoutTurns) => "现在只显示它的设置，没有对话记录。".into(),
        None => String::new(),
    };
    let backup = record_rows::recorded_backup(db).ok().flatten()
        .map(|path| format!("，或停止 Core 后用转换前的备份 {path} 替换 workspace.sqlite（之后的全部变更都会丢失）"))
        .unwrap_or_default();
    format!("{damage}。其他 Agent 不受影响；此 Agent 暂不写入。{shown}恢复：停止 Core 后运行 \
        `yuzuno-workspace --revert-record-rows` 把所有记录存回整行（此 Agent 保留能读出的全部 Turn 和 Item，缺失处会标出，\
        原有的记录行另存在 agent_salvage 中）{backup}。")
}

/// Whether the journal has rows after `seq` that loading this record would
/// replay (see `restore`).
fn replays(db: &Connection, id: &str, seq: i64) -> Result<bool> {
    let mut query = db.prepare_cached("SELECT kind,data FROM journal WHERE agent_id=?1 AND seq>?2")?;
    let rows = query.query_map(params![id, seq], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (kind, data) = row?;
        if replayed(&kind, &serde_json::from_str(&data)?) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// The Workspace's exclusive lock, held as long as the file stays open. A
/// second Core must not mark the first Core's running Agents offline merely
/// because it uses another port, and records are not converted (or
/// reverted) under a running Core. The file is read-only while older Cores
/// are kept out (older_cores.rs); the lock needs no write access.
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

/// Applies what was journaled after the record was last written: deferred
/// events whose record write had not happened yet (Core was killed, or the
/// write failed) and read marks. Every other event is written together with
/// its record, so nothing else can be missing. Each event is applied as of
/// its journal time, exactly as it was live. Ephemeral kinds are journaled
/// only when they changed what Core acts on, and then with their record;
/// rows of them that earlier builds journaled are replayed too, so their
/// text survives an upgrade after a crash. Evidence is never applied.
/// Returns what replaying changed: the record's rows lack it.
///
/// An event whose replay panics (a bug in applying it) is skipped: replay
/// starts over from the record as loaded without it, and the Agent shows an
/// error naming it. The record stays readable and writable; it is not
/// `Damaged`, whose rows do not assemble.
fn restore(db: &Connection, id: &str, detail: &mut AgentDetail) -> Result<Dirty> {
    let rows: Vec<(i64, String, Value, String)> = {
        let mut query = db.prepare_cached("SELECT seq,kind,data,at FROM journal WHERE agent_id=?1 AND seq>?2 ORDER BY seq")?;
        let rows = query.query_map(params![id, detail.agent.last_seq], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
        })?;
        rows.map(|row| {
            let (seq, kind, data, at) = row?;
            Ok((seq, kind, serde_json::from_str(&data)?, at))
        }).collect::<Result<_>>()?
    };
    let applied = |kind: &str, data: &Value| kind != "workspace/reviewed" && replayed(kind, data);
    // Kept only when there is something to apply, to start over from.
    let loaded = rows.iter().any(|(_, kind, data, _)| applied(kind, data)).then(|| detail.clone());
    let mut skipped: Vec<(i64, String)> = Vec::new();
    loop {
        let mut replayed = Dirty::default();
        let mut reviewed = false;
        let mut panicked = None;
        for (seq, kind, data, at) in &rows {
            if kind == "workspace/reviewed" {
                let through = data["throughSeq"].as_i64().unwrap_or(0);
                if through > detail.agent.reviewed_seq {
                    detail.agent.reviewed_seq = through;
                    reviewed = true;
                }
            } else if applied(kind, data) && !skipped.iter().any(|(skip, _)| skip == seq) {
                let replay = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    apply_streamed(detail, Some(*seq), kind, data, journal_time(at));
                }));
                if replay.is_err() {
                    panicked = Some((*seq, kind.clone()));
                    break;
                }
                replayed.merge(Dirty::of_applied(detail, kind, data));
            }
        }
        if let Some(event) = panicked {
            eprintln!("Workspace skipped event #{} ({}) of Agent {id}: replaying it failed", event.0, event.1);
            skipped.push(event);
            *detail = loaded.clone().expect("kept when there are events to apply");
            continue;
        }
        if reviewed { detail.agent.unread_count = unread(db, id, detail.agent.reviewed_seq)?; }
        if !skipped.is_empty() {
            let events: Vec<String> = skipped.iter().map(|(seq, kind)| format!("#{seq}（{kind}）")).collect();
            detail.agent.error = Some(format!("Workspace 无法重放事件 {}，已跳过；此 Agent 的记录可能缺少这些事件的内容。", events.join("、")));
            // Past them, so the record written next does not replay them
            // again; what they would have changed was never applied.
            if let Some(last) = skipped.iter().map(|(seq, _)| *seq).max() {
                detail.agent.last_seq = detail.agent.last_seq.max(last);
            }
        }
        return Ok(replayed);
    }
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


impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        let workspace_lock = lock_workspace(path)?;
        let mut db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(3))?;
        // FULL is SQLite's default; stated because the writer's unsynced
        // connection uses NORMAL and this one must never (see `db`).
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS journal_agent ON journal(agent_id,seq);
            CREATE TABLE IF NOT EXISTS workspace_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS machines(id TEXT PRIMARY KEY, data TEXT NOT NULL);
            PRAGMA user_version=2;")?;
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
        record_rows::migrate(&db)?;
        // Records stored whole (by an older Core) become rows, before any
        // other connection is open. One that cannot is left whole, and Core
        // keeps working with it.
        match record_rows::convert(&mut db, path) {
            Ok(done) => {
                if let Some(backup) = &done.backup {
                    eprintln!("Workspace copied to {} before converting its records", backup.display());
                }
                if !done.converted.is_empty() {
                    eprintln!("Workspace stores {} more Agent records as rows", done.converted.len());
                }
                for (id, error) in &done.failed {
                    eprintln!("Workspace record of Agent {id} stays whole: {error}");
                }
            }
            Err(error) => eprintln!("Workspace records not converted to rows yet: {error:#}"),
        }
        if let Err(error) = record_rows::expire_originals(&db) {
            eprintln!("Workspace could not forget old pre-conversion records: {error:#}");
        }
        db.execute("INSERT OR IGNORE INTO workspace_meta(key,value) VALUES('workspaceId',?1)",
            [uuid::Uuid::new_v4().to_string()])?;
        let store = Self {
            db: crate::db::Db::new(path, db)?,
            memory: Mutex::new(Memory {
                held: HashMap::new(),
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
            // A damaged record is shown as it is (see `stand_in`) and holds
            // back no other Agent.
            let restarted = store.update(&a.id, "workspace/restarted", &json!({}), |d| {
                if let Some(usage) = &mut d.context_usage { usage.stale = true; }
                for receipt in &mut d.message_receipts {
                    if receipt.status == "sending" { receipt.status = "uncertain".into(); }
                }
                d.agent.connection_state = "disconnected".into();
                // An unknown RPC outcome stays unknown across service restarts.
                // In particular, thread/start may have executed before its reply
                // was lost; silently creating another session would duplicate it.
                if d.agent.status != "uncertain" {d.agent.status = "offline".into();}
                for r in &mut d.pending { r.stale = true; }
                if d.turns.last().is_some_and(|t| t["status"] == "inProgress") {
                    d.agent.error = Some("Workspace 服务已重启；上次执行是否完成尚未确认。发送新消息时将恢复原会话。".into());
                }
            });
            if let Err(error) = restarted {
                eprintln!("Workspace could not mark Agent {} restarted: {error:#}", a.id);
            }
        }
        store.settle_older_cores();
        Ok(store)
    }

    /// The Agent's record lock (see the lock order on `Store`).
    fn record_lock(&self, id: &str) -> Arc<parking_lot::Mutex<()>> {
        self.records.lock().unwrap().entry(id.into()).or_default().clone()
    }

    /// Starts a write of the Agent's rows (see `Rewrite`): call it with the
    /// record lock and the writer held, right before the transaction, so
    /// readers of the Agent wait for no more than the write itself.
    fn rewrite<'a>(&'a self, id: &'a str) -> Rewrite<'a> {
        self.memory.lock().unwrap().bump_version(id);
        Rewrite { store: self, id, done: false }
    }

    /// After a change to an Agent was refused because its record is damaged:
    /// lists it as readers are shown it (see `stand_in`), so the damage is
    /// seen without opening it. The listed view is otherwise built from the
    /// newest Turn alone, which may be intact.
    fn list_damaged(&self, id: &str, error: &anyhow::Error) {
        if error.downcast_ref::<Damaged>().is_none() || self.held(id).is_some() {
            return;
        }
        self.memory.lock().unwrap().damaged.insert(id.into());
        // In full: what made the change fail (a payload row, say) may not be
        // read without payloads.
        let shown = self.db.read().map_err(anyhow::Error::from)
            .and_then(|db| read_record(&db, id, true));
        if let Ok(Some(shown)) = shown {
            let mut listed = brief(&shown.detail);
            let mut memory = self.memory.lock().unwrap();
            listed.agent.rev = memory.rev(id);
            memory.briefs.insert(id.into(), listed);
        }
    }

    /// Remembers what a read found: a damaged record is never changed (see
    /// `Memory::damaged`).
    fn seen(&self, id: &str, shown: Shown) -> AgentDetail {
        if shown.damaged {
            self.memory.lock().unwrap().damaged.insert(id.into());
        }
        shown.detail
    }

    /// The Agent's held record, if it streams.
    fn held(&self, id: &str) -> Option<Arc<RwLock<AgentDetail>>> {
        self.memory.lock().unwrap().held.get(id).map(|held| held.detail.clone())
    }

    /// A requested project is linked in the same transaction, so a new Agent
    /// never exists outside the project it was created for.
    pub fn insert(&self, detail: &AgentDetail) -> Result<()> {
        self.insert_record(detail, false)
    }

    /// A newly created Agent, refused if its SSH machine is no longer
    /// registered. Creation reads the machine and then waits on SSH; checked
    /// in the insert's transaction, a removal in between cannot leave the
    /// Agent on a machine the workspace no longer lists (see remove_machine).
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
            // Closed or not, read without parsing the record.
            let closed: bool = tx.query_row("SELECT json_extract(data,'$.agent.closedAt') IS NOT NULL FROM agents WHERE id=?1",
                [id], |r| r.get(0))?;
            anyhow::ensure!(closed, "请先关闭 Agent，再删除 Workspace 记录");
            record_rows::delete_rows(&tx, id)?;
            tx.execute("DELETE FROM agent_originals WHERE agent_id=?1", [id])?;
            tx.execute("DELETE FROM journal WHERE agent_id=?1", [id])?;
            tx.execute("DELETE FROM agents WHERE id=?1", [id])?;
            crate::results::delete_agent(&tx, id)?;
            crate::project_brief::delete_agent(&tx, id)?;
            crate::codex_sessions::release_forks(&tx, id)?;
            tx.commit()?;
        }
        rewrite.done(|memory| {
            memory.held.remove(id);
            memory.briefs.remove(id);
            memory.announce.remove(id);
            memory.evidence.remove(id);
            memory.damaged.remove(id);
            memory.changed(id);
        });
        // Nothing changes it again; one still waiting keeps its own.
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
        // A Job that runs there is bound to the machine that answered it.
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
    /// there or an unfinished Job runs there, checked in the same transaction
    /// as the delete. Closed Agents keep their own copy of the machine.
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

    pub fn detail(&self, id: &str) -> Result<AgentDetail> {
        self.detail_racing(id, || {})
    }

    /// What a send checks, without copying the rest of the record: the Agent,
    /// its receipts, pending requests and other small fields as `detail` has
    /// them, and each Turn without its Items except the async questions an
    /// answer names. A held record is read under its read lock (it is held
    /// after every commit); one that is not, idle for a while, from its rows
    /// without payloads, which no check reads. Never written back.
    pub fn send_view(&self, id: &str) -> Result<AgentDetail> {
        let mut view = match self.held(id) {
            Some(held) => send_view_of(&held.read()),
            None => send_view_of(&self.current(id, false, &mut || {})?),
        };
        view.agent.project_id = self.agent_project(id)?;
        Ok(view)
    }

    /// The Agent's pending native requests, without copying the rest of the
    /// record: from the held copy under its read lock, else from its rows
    /// without payloads (pending requests are metadata, as for `send_view`).
    pub fn pending(&self, id: &str) -> Result<Vec<PendingRequest>> {
        match self.held(id) {
            Some(held) => Ok(held.read().pending.clone()),
            None => Ok(self.current(id, false, &mut || {})?.pending),
        }
    }

    /// `detail`, running `unlocked` after a record is assembled and before
    /// its journal is replayed; tests race writes against the read there.
    fn detail_racing(&self, id: &str, mut unlocked: impl FnMut()) -> Result<AgentDetail> {
        let mut detail = self.current(id, true, &mut unlocked)?;
        self.annotate_peer_turns(&mut detail)?;
        detail.agent.work_summary = crate::rail::project(&detail);
        detail.agent.project_id = self.agent_project(id)?;
        Ok(detail)
    }

    /// What the detail API sends (`client_view::detail`): the copy held in
    /// memory projected, else the rows without payloads, which already are
    /// that view (Items a pending request refers to with theirs).
    pub fn client_detail(&self, id: &str) -> Result<AgentDetail> {
        let mut detail = self.current(id, false, &mut || {})?;
        self.annotate_peer_turns(&mut detail)?;
        detail.agent.work_summary = crate::rail::project(&detail);
        detail.agent.project_id = self.agent_project(id)?;
        self.annotate_imported_questions(&mut detail)?;
        Ok(crate::client_view::detail(detail))
    }

    /// Window reads retain the complete light index, questions and receipts,
    /// but only copy/decode body candidates. The held path borrows its record;
    /// the Rows path uses a rebuildable index and exact row keys (also for
    /// duplicate/missing native IDs). Original and full-detail reads are intact.
    pub fn client_window(&self, id: &str, query: &crate::conversation_window::Query)
        -> Result<std::result::Result<ConversationWindow, crate::client_view::Missing>> {
        self.client_window_racing(id, query, || {})
    }

    fn client_window_racing(&self, id: &str, query: &crate::conversation_window::Query, mut unlocked: impl FnMut())
        -> Result<std::result::Result<ConversationWindow, crate::client_view::Missing>> {
        let mut attempt = 0;
        loop {
            let lock = (attempt >= 2).then(|| self.record_lock(id));
            let _record = lock.as_ref().map(|lock| lock.lock());
            let (held, version, rev, damaged) = {
                let memory = self.memory.lock().unwrap();
                (memory.held.get(id).map(|held| held.detail.clone()), memory.version(id), memory.rev(id), memory.damaged.contains(id))
            };
            if let Some(held) = held {
                // Connection before held lock: never acquire the DB while a
                // writer could be waiting for the held record we borrowed.
                let db = self.db.read()?;
                let detail = held.read();
                let mut index = crate::conversation_window::index(&detail);
                index.agent.work_summary = crate::rail::project(&detail);
                return Ok(project_window(&db, index, query, |t, i| Ok(detail.turns[t]["items"][i].clone()))?
                    .map(|(detail, conversation)| ConversationWindow { detail, conversation,
                        stats:record_rows::window::ReadStats { source:"held", ..Default::default() } }));
            }
            if version % 2 == 1 {
                attempt += 1;
                std::thread::yield_now();
                continue;
            }
            let (found, fills) = {
                let db = self.db.read()?;
                self.window_rows(&db, id, query, damaged)?
            };
            unlocked();
            {
                let memory = self.memory.lock().unwrap();
                if memory.held.contains_key(id) || memory.version(id) != version {
                    attempt += 1;
                    continue;
                }
            }
            // Cache publication is conditional on unchanged source rows. It
            // is independent of the record revision and safe after the read.
            if !fills.is_empty() {
                let mut writer = self.db.write()?;
                let tx = writer.transaction()?;
                record_rows::window::fill(&tx, id, fills)?;
                tx.commit()?;
            }
            return Ok(found.map(|mut window| { window.detail.agent.rev = rev; window }));
        }
    }

    fn window_rows(&self, db: &Connection, id: &str, query: &crate::conversation_window::Query, damaged: bool)
        -> Result<(std::result::Result<ConversationWindow, crate::client_view::Missing>, Vec<record_rows::window::Fill>)> {
        let whole = || -> Result<_> {
            let detail = self.seen(id, read_record(db, id, damaged)?.context("Agent 不存在")?);
            let mut index = crate::conversation_window::index(&detail);
            index.agent.work_summary = crate::rail::project(&detail);
            Ok((project_window(db, index, query, |t, i| Ok(detail.turns[t]["items"][i].clone()))?
                .map(|(detail, conversation)| ConversationWindow { detail, conversation,
                    stats:record_rows::window::ReadStats { source:"fallback", ..Default::default() } }), Vec::new()))
        };
        if damaged || record_rows::layout(db, id)? != Some(Layout::Rows) { return whole(); }
        let read = || -> Result<_> {
            let record_rows::window::Index { mut detail, keys, fills, mut stats } = record_rows::window::index(db, id)?;
            if replays(db, id, detail.agent.last_seq)? { return whole(); }
            let wanted = crate::client_view::referenced(&detail.pending);
            // Legacy Pending hydration resolves ambiguous IDs through
            // load_item (newest match), not by row position. Preserve that
            // behavior on this exceptional path instead of changing it here.
            if detail.turns.iter().enumerate().any(|(t, turn)| {
                turn["items"].as_array().into_iter().flatten().enumerate().any(|(i, item)| {
                    item["id"].as_str().is_some_and(|id| wanted.contains(id))
                        && (keys[t].0.starts_with('~') || keys[t].1[i].starts_with('~'))
                })
            }) { return whole(); }
            let mut bodies: HashMap<(usize, usize), Value> = HashMap::new();
            let mut body = |t: usize, i: usize| -> Result<Value> {
                if let Some(item) = bodies.get(&(t,i)) { return Ok(item.clone()); }
                let full = detail.turns[t]["items"][i]["id"].as_str().is_some_and(|id| wanted.contains(id));
                let item = record_rows::window::item(db, id, &keys[t].0, &keys[t].1[i], full, &mut stats)?;
                bodies.insert((t,i), item.clone());
                Ok(item)
            };
            // The rail reads only the first user message and the last two
            // assistant candidates of the newest Turn. Keep its exact logic
            // without parsing the rest of a giant latest Turn.
            let mut rail = crate::conversation_window::header(&detail);
            if let Some(t) = detail.turns.len().checked_sub(1) {
                let mut turn = crate::conversation_window::turn_shell(&detail.turns[t]);
                let items = detail.turns[t]["items"].as_array();
                let mut positions = Vec::new();
                if let Some(items) = items {
                    positions.extend(items.iter().position(|i| i["type"] == "userMessage"));
                    for key in ["text", "_yuzunoCompletedText"] {
                        positions.extend(items.iter().rposition(|i| i["type"] == "agentMessage" && i[key].as_str().is_some_and(|s| !s.trim().is_empty())));
                    }
                }
                positions.sort_unstable();
                positions.dedup();
                for i in positions { turn["items"].as_array_mut().unwrap().push(body(t,i)?); }
                rail.turns.push(turn);
            }
            let summary = crate::rail::project(&rail);
            // Release immutable borrows used to decide pending payload reads
            // before moving the compact record into the projection.
            drop(body);
            detail.agent.work_summary = summary;
            let mut whole_positions = HashSet::new();
            for (t, turn) in detail.turns.iter().enumerate() {
                for (i, item) in turn["items"].as_array().into_iter().flatten().enumerate() {
                    if item["id"].as_str().is_some_and(|id| wanted.contains(id)) { whole_positions.insert((t,i)); }
                }
            }
            let found = project_window(db, detail, query, |t, i| {
                if let Some(item) = bodies.remove(&(t,i)) { return Ok(item); }
                // Key lookup is positional, so repeated native IDs retain the
                // same first-match cursor semantics as the old projection.
                let full = whole_positions.contains(&(t,i));
                record_rows::window::item(db, id, &keys[t].0, &keys[t].1[i], full, &mut stats)
            })?;
            Ok((found.map(|(detail, conversation)| ConversationWindow { detail, conversation, stats }), fills))
        };
        match read() {
            Err(e) if e.is::<Damaged>() => whole(),
            result => result,
        }
    }

    /// Runs `read` on the Agent's record as far as one payload request needs
    /// it: the copy held in memory, else (in one snapshot) its metadata and
    /// one Turn with its payloads, or only one Item of it (`item`, in Turn
    /// `turn`, or in the newest Turn holding it). With a Turn ID that names a
    /// Turn without that Item, the Turn holds no Items. A record stored
    /// whole, with journaled changes its rows lack, or damaged is read as
    /// `detail` reads it. The snapshot is checked against the Agent's
    /// version as in `current`, so a record held (or written) meanwhile is
    /// not answered from older rows. None if there is no such Agent.
    pub fn payload_view<T>(&self, id: &str, turn: Option<&str>, item: Option<&str>,
        read: impl FnOnce(&AgentDetail) -> T) -> Result<Option<T>> {
        self.payload_view_racing(id, turn, item, read, || {})
    }

    /// `payload_view`, running `unlocked` after the rows are read and before
    /// the version is checked again; tests race writes there.
    fn payload_view_racing<T>(&self, id: &str, turn: Option<&str>, item: Option<&str>,
        read: impl FnOnce(&AgentDetail) -> T, mut unlocked: impl FnMut()) -> Result<Option<T>> {
        let mut attempt = 0;
        let found = loop {
            let exclusive = attempt >= 2;
            let lock = exclusive.then(|| self.record_lock(id));
            let _record = lock.as_ref().map(|lock| lock.lock());
            let (held, version, damaged) = {
                let memory = self.memory.lock().unwrap();
                (memory.held.get(id).map(|held| held.detail.clone()), memory.version(id), memory.damaged.contains(id))
            };
            if let Some(held) = held {
                return Ok(Some(read(&held.read())));
            }
            if version % 2 == 1 {
                attempt += 1;
                std::thread::yield_now();
                continue;
            }
            let found = {
                let db = self.db.read()?;
                if damaged {
                    // Answered from its stand-in, as its detail is.
                    read_record(&db, id, true)?.map(|shown| self.seen(id, shown))
                } else {
                    self.payload_rows(&db, id, turn, item)?
                }
            };
            unlocked();
            let held = {
                let memory = self.memory.lock().unwrap();
                match memory.held.get(id) {
                    Some(held) => Some(held.detail.clone()),
                    None if memory.version(id) == version => None,
                    None => {
                        attempt += 1;
                        continue;
                    }
                }
            };
            if let Some(held) = held {
                return Ok(Some(read(&held.read())));
            }
            break found;
        };
        Ok(found.map(|detail| read(&detail)))
    }

    /// `payload_view` from rows, in one snapshot.
    fn payload_rows(&self, db: &Connection, id: &str, turn: Option<&str>, item: Option<&str>) -> Result<Option<AgentDetail>> {
        let whole = |db: &Connection| -> Result<Option<AgentDetail>> {
            Ok(read_record(db, id, true)?.map(|shown| self.seen(id, shown)))
        };
        // Its layout first: a record stored whole is parsed once.
        match record_rows::layout(db, id)? {
            None => return Ok(None),
            Some(Layout::Whole) => return whole(db),
            Some(Layout::Rows) => {}
        }
        let mut meta = match record_rows::load_meta(db, id) {
            Ok(Some(meta)) => meta,
            Ok(None) => return Ok(None),
            Err(error) if error.is::<Damaged>() => return whole(db),
            Err(error) => return Err(error),
        };
        if replays(db, id, meta.agent.last_seq)? {
            return whole(db);
        }
        let found = match (turn, item) {
            (_, Some(item)) => record_rows::load_item(db, id, turn, item, true),
            (Some(turn), None) => record_rows::load_turn(db, id, turn, true),
            (None, None) => Ok(None),
        };
        match found {
            Ok(found) => {
                meta.turns.extend(found);
                Ok(Some(meta))
            }
            Err(error) if error.is::<Damaged>() => whole(db),
            Err(error) => Err(error),
        }
    }

    /// The record as it is now: a copy of the one held in memory (whose rev
    /// changes with its content), else its rows (without payloads: see
    /// `read_record`) with what its journal adds, all read in one snapshot,
    /// so a Turn end and the events after it are in the result together or
    /// not at all. The rows are assembled on a reader, holding nothing anyone
    /// else waits for. The rev returned is exactly that of the last change
    /// the snapshot holds: the Agent's version is the same and even before
    /// and after it (see `Memory::versions`). A write racing the read makes
    /// it read again; after two such races it is read under the Agent's
    /// record lock, where no write of it can race.
    fn current(&self, id: &str, payloads: bool, unlocked: &mut impl FnMut()) -> Result<AgentDetail> {
        let mut attempt = 0;
        loop {
            let exclusive = attempt >= 2;
            let lock = exclusive.then(|| self.record_lock(id));
            let _record = lock.as_ref().map(|lock| lock.lock());
            let (held, version, rev, damaged) = {
                let memory = self.memory.lock().unwrap();
                (memory.held.get(id).map(|held| held.detail.clone()), memory.version(id), memory.rev(id),
                    memory.damaged.contains(id))
            };
            if let Some(held) = held {
                return Ok(held.read().clone());
            }
            // A record known to be damaged is shown as its stand-in, which a
            // read without payloads may not find (a payload row is missing).
            let payloads = payloads || damaged;
            if version % 2 == 1 {
                // A write of it is being committed; its writer holds the
                // record lock, so this is never the case once that is held.
                attempt += 1;
                std::thread::yield_now();
                continue;
            }
            // The snapshot begins with its first read, after `version` was
            // read: it holds every write that version counts, and any newer
            // one changes the version before it commits.
            let mut detail = {
                let db = self.db.read()?;
                let stored = record_rows::read(&db, id, payloads)?.context("Agent 不存在")?;
                let assembled = record_rows::assemble_stored(id, stored, payloads);
                unlocked();
                let shown = finish(&db, id, assembled, payloads)?;
                self.seen(id, shown)
            };
            let held = {
                let memory = self.memory.lock().unwrap();
                match memory.held.get(id) {
                    Some(held) => Some(held.detail.clone()),
                    None if memory.version(id) == version => None,
                    None => {
                        attempt += 1;
                        continue;
                    }
                }
            };
            if let Some(held) = held {
                return Ok(held.read().clone());
            }
            detail.agent.rev = rev;
            return Ok(detail);
        }
    }

    /// One Agent as listed. A record is parsed only the first time it is
    /// listed after Core starts; every write keeps this view current.
    pub fn agent(&self, id: &str) -> Result<Agent> {
        Ok(self.listed(id, Load::Reader)?.context("Agent 不存在")?.agent)
    }

    /// Update safety checks use the same versioned view as Agent listing,
    /// without cloning held history or loading old Item/payload rows. As with
    /// `current`, retry a concurrent committed rewrite instead of accepting a
    /// cached view built before it. Sealing admission still fences new work.
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

    /// `agent` when it needs no record parsed (it is listed, or held):
    /// cheap enough for any thread, async workers included. None otherwise.
    pub fn listed_agent(&self, id: &str) -> Option<Agent> {
        self.listed(id, Load::Never).ok().flatten().map(|listed| listed.agent)
    }

    /// `agent` for a caller already in a transaction (the collaboration
    /// paths): a record it has to parse is read through that transaction.
    /// None if there is no such Agent.
    pub(crate) fn brief_in(&self, db: &Connection, id: &str) -> Result<Option<Brief>> {
        self.listed(id, Load::Through(db))
    }

    /// The Agent's listed view with its current rev: kept with every write,
    /// rebuilt from the held copy when streamed events left it stale, and
    /// parsed from the row only the first time after Core starts. Nothing is
    /// parsed or copied while `memory` is held. A view built from a row is
    /// kept only if no write to that Agent raced it and the read saw every
    /// commit before it began (a new reader or the writer does; a caller's
    /// older read snapshot may not), so a deleted or rewritten Agent's old
    /// view never comes back.
    fn listed(&self, id: &str, load: Load) -> Result<Option<Brief>> {
        enum Source {
            Cached(Brief),
            Held(Arc<RwLock<AgentDetail>>, u64),
            Row(u64),
        }
        // Each view carries the rev of what it was built from: a cached one
        // its own, one built from the held copy that copy's.
        let (source, rev) = {
            let memory = self.memory.lock().unwrap();
            let source = match memory.held.get(id) {
                Some(held) if held.brief_stale || !memory.briefs.contains_key(id) => {
                    Source::Held(held.detail.clone(), held.changes)
                }
                _ => match memory.briefs.get(id) {
                    Some(brief) => Source::Cached(brief.clone()),
                    None => Source::Row(memory.version(id)),
                },
            };
            (source, memory.rev(id))
        };
        let listed = match source {
            Source::Cached(brief) => brief,
            Source::Held(detail, changes) => {
                let listed = brief(&detail.read());
                let mut guard = self.memory.lock().unwrap();
                let memory = &mut *guard;
                if let Some(held) = memory.held.get_mut(id)
                    .filter(|held| Arc::ptr_eq(&held.detail, &detail) && held.changes == changes) {
                    held.brief_stale = false;
                    memory.briefs.insert(id.into(), listed.clone());
                }
                listed
            }
            Source::Row(version) => {
                let (detail, current_view) = match load {
                    Load::Never => return Ok(None),
                    // Its metadata, Turn rows and newest Turn only.
                    Load::Reader => (read_recent(&*self.db.read()?, id)?, true),
                    Load::Through(db) => (read_recent(db, id)?, !db.is_readonly(rusqlite::MAIN_DB).unwrap_or(true)),
                };
                let Some(shown) = detail else { return Ok(None) };
                let detail = self.seen(id, shown);
                let mut listed = brief(&detail);
                // Read with `version`: exactly the rev of what the read holds
                // if no write raced it, else no newer than it.
                listed.agent.rev = rev;
                let mut guard = self.memory.lock().unwrap();
                let memory = &mut *guard;
                if current_view && version % 2 == 0 && memory.version(id) == version && !memory.held.contains_key(id) {
                    memory.briefs.entry(id.into()).or_insert_with(|| listed.clone());
                }
                listed
            }
        };
        Ok(Some(listed))
    }

    /// Whether the Agent is closed, and the Codex thread it is bound to:
    /// what checking an event's owner needs. Deferred events change neither,
    /// so this neither parses a record nor rebuilds a brief.
    pub fn binding(&self, id: &str) -> Result<(bool, Option<String>)> {
        if let Some(held) = self.held(id) {
            let d = held.read();
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

    /// The one place a streamed native event, Codex or Claude, reaches the
    /// record held in memory (see `apply_streamed`); `route` is the event's
    /// (see `route`). Evidence is journaled only, on the writer's unsynced
    /// connection; Ignored and Synchronous events are not handled here.
    ///
    /// An ephemeral event is applied in memory; a deferred one is journaled
    /// (unsynced) and applied, and its record written once STREAM_WRITE_AFTER
    /// has passed (see `stream_tick`) or by the next update() for this Agent.
    /// Either is announced by the next tick, unless it changed what other
    /// parts of Core act on (`Watched`): then it is journaled if it was not
    /// yet, its record written at once with a synced commit, and `urgent` set
    /// so the caller announces it now. A record is parsed (the first time it
    /// streams) and serialized without the writer.
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
        let journaled = route == Route::Deferred;
        let loaded = if self.held(id).is_some() {
            None
        } else {
            self.make_room(id, MAX_STREAMS - 1);
            let loaded = load(&*self.db.read()?, id);
            if let Err(error) = &loaded {
                self.list_damaged(id, error);
            }
            Some(loaded?)
        };
        let seq = if journaled {
            let mut db = self.db.write()?;
            let unsynced = db.unsynced();
            unsynced.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,?2,?3,?4)",
                params![id, kind, data.to_string(), at.to_rfc3339()])?;
            Some(unsynced.last_insert_rowid())
        } else {
            None
        };
        // Memory changes only after the commit, so a failed write leaves no
        // half-applied copy and a retry never applies an event twice. The
        // change's rev is taken first (the record lock orders this Agent's
        // changes) and set with the change, so a copy never has one without
        // the other; a copy just loaded has the rev of what it holds.
        let now = Instant::now();
        let (detail, rev, inserted) = {
            let mut memory = self.memory.lock().unwrap();
            let inserted = loaded.is_some();
            if let Some((mut detail, replayed)) = loaded {
                detail.agent.rev = memory.rev(id);
                memory.held.insert(id.into(), Held::new(detail, replayed, now));
            }
            let rev = memory.event(id, kind, data);
            (memory.held[id].detail.clone(), rev, inserted)
        };
        if inserted {
            // Others streaming at the same moment may have filled the room.
            self.make_room(id, MAX_STREAMS);
        }
        let applied = {
            let mut d = detail.write();
            let before = watched(&d);
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| apply_streamed(&mut d, seq, kind, data, at)))
                .map(|()| {
                    d.agent.rev = rev;
                    (before, watched(&d), Dirty::of_applied(&d, kind, data))
                })
        };
        let Ok((before, after, dirty)) = applied else {
            // A bug in applying it left the copy half-changed: it is dropped
            // and rebuilt from the rows and the journal when next needed,
            // which skips the event and says so (see `restore`).
            let mut memory = self.memory.lock().unwrap();
            memory.held.remove(id);
            memory.briefs.remove(id);
            bail!("Workspace 无法应用事件（{kind}）；Agent 的记录将从存储重建");
        };
        {
            let mut guard = self.memory.lock().unwrap();
            let memory = &mut *guard;
            let held = memory.held.get_mut(id).expect("held above");
            held.unwritten.merge(dirty);
            if journaled {
                held.unwritten_since.get_or_insert(now);
            } else {
                held.ephemeral = true;
            }
            held.last = now;
            held.brief_stale = true;
            held.changes += 1;
            if before == after {
                memory.announce.insert(id.into());
            }
        }
        if before == after {
            return Ok(Streamed { rev: Some(rev), urgent: false });
        }
        // Other parts of Core act on this at once, so it must survive a
        // crash like the events that normally change it: journaled (if it
        // was only streaming output) and written with one synced commit. If
        // that fails it stays in memory; a journaled event is written by the
        // ticker.
        let written = (|| -> Result<Rewrite<'_>> {
            let (plan, mut agent) = self.plan_held(id, &detail)?;
            let mut db = self.db.write()?;
            let rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            if !journaled {
                tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,?2,?3,?4)",
                    params![id, kind, data.to_string(), at.to_rfc3339()])?;
                agent.last_seq = tx.last_insert_rowid();
            }
            record_rows::apply(&tx, id, &plan, &agent)?;
            tx.commit()?;
            detail.write().agent.last_seq = agent.last_seq;
            Ok(rewrite)
        })();
        let written = match written {
            Ok(rewrite) => {
                rewrite.done(|_| ());
                true
            }
            Err(error) => {
                eprintln!("Workspace record of Agent {id} not written yet: {error}");
                false
            }
        };
        let listed = brief(&detail.read());
        let mut guard = self.memory.lock().unwrap();
        let memory = &mut *guard;
        if let Some(held) = memory.held.get_mut(id) {
            if written {
                held.unwritten = Dirty::default();
                held.unwritten_since = None;
                held.ephemeral = false;
            }
            held.brief_stale = false;
            held.changes += 1;
        }
        memory.briefs.insert(id.into(), listed);
        Ok(Streamed { rev: Some(rev), urgent: true })
    }

    /// Prepares writing what a held record's rows lack (see
    /// `record_rows::plan`) on a reader: the caller holds the Agent's record
    /// lock, so neither the copy nor its rows change until it is applied.
    /// Returns the plan and the record's `agent` as it was planned.
    fn plan_held(&self, id: &str, detail: &RwLock<AgentDetail>) -> Result<(record_rows::Plan, Agent)> {
        let unwritten = self.memory.lock().unwrap().held.get(id).map(|held| held.unwritten.clone()).unwrap_or_default();
        let db = self.db.read()?;
        let d = detail.read();
        Ok((record_rows::plan(&db, id, &d, &unwritten)?, d.agent.clone()))
    }

    /// Writes what a held record's rows lack on the writer's unsynced
    /// connection: its journaled events are already durable, and its
    /// ephemeral output need not be. Planned (serialized) before the writer
    /// is taken; the caller holds the Agent's record lock, so the copy cannot
    /// change meanwhile.
    fn write_held(&self, id: &str) -> Result<()> {
        let detail = self.held(id).context("record not held")?;
        let (plan, agent) = self.plan_held(id, &detail)?;
        let rewrite;
        {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(id);
            let tx = db.unsynced().transaction()?;
            record_rows::apply(&tx, id, &plan, &agent)?;
            tx.commit()?;
        }
        rewrite.done(|memory| {
            if let Some(held) = memory.held.get_mut(id) {
                held.unwritten = Dirty::default();
                held.unwritten_since = None;
                held.ephemeral = false;
            }
        });
        Ok(())
    }

    /// Drops a written held record, keeping its brief current. The caller
    /// holds the Agent's record lock.
    fn release(&self, id: &str) {
        let held = self.memory.lock().unwrap().held.get(id).map(|held| (held.detail.clone(), held.brief_stale));
        let Some((detail, stale)) = held else { return };
        let listed = stale.then(|| brief(&detail.read()));
        let mut memory = self.memory.lock().unwrap();
        memory.held.remove(id);
        if let Some(listed) = listed {
            memory.briefs.insert(id.into(), listed);
        }
    }

    /// Brings the held records down to `keep` (MAX_STREAMS - 1 to make room
    /// for one, MAX_STREAMS after one was added, since others may have added
    /// theirs meanwhile), never dropping `except`: records their rows already
    /// match go first, then the least recently streamed are written and
    /// dropped. One whose Agent is being changed right now is passed over
    /// (the next tick tries again). If a write fails that record stays held
    /// (memory is over the bound until a write succeeds) rather than holding
    /// back the event that needs the room.
    fn make_room(&self, except: &str, keep: usize) {
        let candidates: Vec<String> = {
            let memory = self.memory.lock().unwrap();
            if memory.held.len() <= keep {
                return;
            }
            let mut held: Vec<_> = memory.held.iter()
                .filter(|(id, _)| id.as_str() != except)
                .map(|(id, held)| (held.dirty(), held.last, id.clone()))
                .collect();
            // Clean ones first, then the least recently streamed.
            held.sort();
            held.into_iter().map(|(_, _, id)| id).collect()
        };
        for id in candidates {
            if self.memory.lock().unwrap().held.len() <= keep {
                return;
            }
            let lock = self.record_lock(&id);
            let Some(_record) = lock.try_lock() else { continue };
            let dirty = match self.memory.lock().unwrap().held.get(&id) {
                Some(held) => held.dirty(),
                // Dropped meanwhile.
                None => continue,
            };
            if dirty {
                if let Err(error) = self.write_held(&id) {
                    eprintln!("Workspace could not write Agent {id} to make room: {error}");
                    return;
                }
            }
            self.release(&id);
        }
    }

    /// Writes held records whose journaled changes have waited `write_after`
    /// and forgets idle ones. Ephemeral output alone is never due. Each record
    /// is written in its own transaction, and announcements and idle cleanup
    /// happen whatever the writes did, so one record that cannot be written
    /// holds back no other Agent. The writer is taken only for a due record.
    pub fn stream_tick(&self, write_after: Duration) -> Tick {
        self.tick(|h| h.unwritten_since.is_some_and(|since| since.elapsed() >= write_after))
    }

    /// Writes every held record its row lacks something of, ephemeral output
    /// included: on close, and for a controlled restart.
    pub fn flush(&self) -> Tick {
        self.tick(Held::dirty)
    }

    fn tick(&self, due: impl Fn(&Held) -> bool) -> Tick {
        let due_now = |id: &str| self.memory.lock().unwrap().held.get(id).is_some_and(&due);
        let candidates: Vec<String> = self.memory.lock().unwrap().held.iter()
            .filter(|(_, held)| due(held))
            .map(|(id, _)| id.clone()).collect();
        let mut failed = Vec::new();
        for id in &candidates {
            let lock = self.record_lock(id);
            let _record = lock.lock();
            // Not if an event wrote it meanwhile.
            if !due_now(id) {
                continue;
            }
            if let Err(error) = self.write_held(id) {
                failed.push(error.context(format!("Agent {id} 的记录未写入")));
            }
        }
        let idle = |held: &Held| !held.dirty() && held.last.elapsed() >= STREAM_IDLE;
        let candidates: Vec<String> = self.memory.lock().unwrap().held.iter()
            .filter(|(_, held)| idle(held))
            .map(|(id, _)| id.clone()).collect();
        for id in &candidates {
            let lock = self.record_lock(id);
            // One being changed right now is not idle.
            let Some(_record) = lock.try_lock() else { continue };
            if self.memory.lock().unwrap().held.get(id.as_str()).is_some_and(idle) {
                self.release(id);
            }
        }
        // Over the bound only while records were being changed at once.
        self.make_room("", MAX_STREAMS);
        // Record locks nobody holds or waits for: one is made again on use.
        self.records.lock().unwrap().retain(|_, lock| Arc::strong_count(lock) > 1);
        Tick { announce: self.memory.lock().unwrap().announce.drain().collect(), failed }
    }

    /// How many parsed records are held (at most MAX_STREAMS while writes
    /// succeed).
    pub fn streamed_records(&self) -> usize {
        self.memory.lock().unwrap().held.len()
    }

    pub fn update(
        &self,
        id: &str,
        kind: &str,
        data: &Value,
        mutate: impl FnOnce(&mut AgentDetail),
    ) -> Result<AgentDetail> {
        Ok(self.commit(id, kind, data, Scope::Compare, mutate, |d, project_id| {
            let mut copy = d.clone();
            copy.agent.project_id = project_id;
            copy.agent.work_summary = crate::rail::project(&copy);
            copy
        })?.1)
    }

    /// `update` returning only what `pick` takes from the committed record,
    /// as `update` would return it (after `message_content::bind`), without
    /// copying the rest of the record.
    pub fn update_picking<T>(
        &self,
        id: &str,
        kind: &str,
        data: &Value,
        mutate: impl FnOnce(&mut AgentDetail),
        pick: impl FnOnce(&AgentDetail) -> T,
    ) -> Result<T> {
        Ok(self.commit(id, kind, data, Scope::Compare, mutate, |d, _| pick(d))?.1)
    }

    /// `update` without returning the record, which saves copying a large
    /// record held in memory. For native events, whose callers only announce
    /// the change. Returns the change's rev (see `Agent::rev`).
    pub fn record_event(
        &self,
        id: &str,
        kind: &str,
        data: &Value,
        mutate: impl FnOnce(&mut AgentDetail),
    ) -> Result<u64> {
        Ok(self.commit(id, kind, data, Scope::Compare, mutate, |_, _| ())?.0)
    }

    /// `record_event` for a change to the record's metadata only: `mutate`
    /// gets no Turn (see `Meta`). What it wrote is found without comparing the
    /// whole record: the metadata, and the Items `message_content::restore`
    /// changed. Returns the change's rev.
    pub fn update_meta(&self, id: &str, kind: &str, data: &Value, mutate: impl FnOnce(&mut Meta<'_>)) -> Result<u64> {
        Ok(self.commit_meta(id, kind, data, mutate, |_, _| ())?.0)
    }

    /// `update_picking` for a change to the metadata only (see `update_meta`).
    pub fn update_picking_meta<T>(
        &self,
        id: &str,
        kind: &str,
        data: &Value,
        mutate: impl FnOnce(&mut Meta<'_>),
        pick: impl FnOnce(&AgentDetail) -> T,
    ) -> Result<T> {
        Ok(self.commit_meta(id, kind, data, mutate, |d, _| pick(d))?.1)
    }

    /// `record_event` for one native event that the record takes as
    /// `AgentDetail::apply(applied, data)` does, journaled as `kind`
    /// (`turn/accepted` applies the RPC response as `turn/started`). What it
    /// wrote is what the event names (`Dirty::of_applied`) and the Items
    /// `message_content::restore` changed, not found by comparing the whole
    /// record. Returns the change's rev.
    pub fn record_applied(&self, id: &str, kind: &str, applied: &str, data: &Value) -> Result<u64> {
        Ok(self.commit(id, kind, data, Scope::Applied(applied), |d| d.apply(applied, data), |_, _| ())?.0)
    }

    /// The record is read (a copy of the held one, else its rows), changed,
    /// compared and its changed rows serialized under the Agent's record lock
    /// only; the writer is held just for the journal row, the unread count
    /// and those rows. Until the commit, readers see the record as it was; if
    /// the write fails it stays so (nothing half-applied, held output not
    /// lost). The written record stays held, so the next event or update (a
    /// Turn start is several) need not load it. `pick` gets the committed
    /// record and its project; what it returns is returned with the rev.
    fn commit<T>(
        &self,
        id: &str,
        kind: &str,
        data: &Value,
        scope: Scope<'_>,
        mutate: impl FnOnce(&mut AgentDetail),
        pick: impl FnOnce(&AgentDetail, Option<String>) -> T,
    ) -> Result<(u64, T)> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        self.commit_locked(id, kind, data, scope, mutate, pick)
    }

    /// `commit`, for a caller holding the Agent's record lock.
    fn commit_locked<T>(
        &self,
        id: &str,
        kind: &str,
        data: &Value,
        scope: Scope<'_>,
        mutate: impl FnOnce(&mut AgentDetail),
        pick: impl FnOnce(&AgentDetail, Option<String>) -> T,
    ) -> Result<(u64, T)> {
        // The held copy is newer than the row: it has the streamed events.
        let held = self.held(id);
        let (mut d, mut unwritten, loaded) = match &held {
            Some(detail) => {
                let unwritten = self.memory.lock().unwrap().held.get(id).map(|held| held.unwritten.clone()).unwrap_or_default();
                (detail.read().clone(), unwritten, None)
            }
            None => {
                let loaded = load(&*self.db.read()?, id);
                if let Err(error) = &loaded {
                    self.list_damaged(id, error);
                }
                let (detail, replayed) = loaded?;
                let before = detail.clone();
                (detail, replayed, Some(before))
            }
        };
        let ((), restored) = crate::message_content::collect_restored(|| {
            mutate(&mut d);
            crate::message_content::bind(&mut d.turns, &mut d.message_receipts);
        });
        d.agent.pending_count = d.pending.len() as u64;
        d.agent.updated_at = now();
        // What `mutate` changed (it may change anything) is found by
        // comparing, unless its scope names it; only that is written. A
        // record just loaded is compared with the copy kept for that.
        unwritten.merge(match (&held, &loaded) {
            (Some(detail), _) => scoped(&scope, &d, data, restored).unwrap_or_else(|| Dirty::between(&detail.read(), &d)),
            (None, Some(before)) => Dirty::between(before, &d),
            (None, None) => Dirty::all(),
        });
        drop(loaded);
        let plan = record_rows::plan(&*self.db.read()?, id, &d, &unwritten)?;
        #[cfg(test)]
        if let Some((watched, planned)) = &*AFTER_PLAN.lock().unwrap() {
            if watched == id {
                let _ = planned.send(());
            }
        }
        let rewrite;
        let (already_completed, project_id) = {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            // A live completion can race history reconciliation. Both may update
            // the evidence, but only the first creates an unread result.
            let already_completed: bool = kind == "turn/completed" && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM journal WHERE agent_id=?1 AND kind='turn/completed' AND json_extract(data,'$.turn.id')=?2)
                    OR EXISTS(SELECT 1 FROM codex_import_turns WHERE agent_id=?1 AND turn_id=?2)",
                params![id, data["turn"]["id"].as_str()], |r| r.get(0))?;
            tx.execute(
                "INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,?2,?3,?4)",
                params![id, if already_completed { "turn/reconfirmed" } else { kind }, data.to_string(), now()],
            )?;
            d.agent.last_seq = tx.last_insert_rowid();
            d.agent.unread_count = unread(&tx, id, d.agent.reviewed_seq)?;
            record_rows::apply(&tx, id, &plan, &d.agent)?;
            // Projected only after the record is written, like work_summary.
            let project_id = crate::projects::agent_project(&tx, id)?;
            tx.commit()?;
            #[cfg(test)]
            AFTER_COMMIT.with(|hook| if let Some(hook) = hook.borrow_mut().as_mut() { hook() });
            (already_completed, project_id)
        };
        drop(plan);
        let mut listed = brief(&d);
        // Visible with the commit (see `Rewrite`): the rows, their rev and
        // the brief. A held copy still has the previous rev with its
        // previous content until it is replaced below.
        let rev = rewrite.done(|memory| {
            let rev = memory.event(id, if already_completed { "turn/reconfirmed" } else { kind }, data);
            listed.agent.rev = rev;
            memory.briefs.insert(id.into(), listed);
            rev
        });
        d.agent.rev = rev;
        let picked = pick(&d, project_id);
        if held.is_none() {
            self.make_room(id, MAX_STREAMS - 1);
        }
        self.memory.lock().unwrap().held.insert(id.into(), Held::new(d, Dirty::default(), Instant::now()));
        if held.is_none() {
            self.make_room(id, MAX_STREAMS);
        }
        Ok((rev, picked))
    }

    /// `commit` of a change to the metadata alone (see `Meta`) of a record
    /// held in memory, without copying or comparing its Turns, which were
    /// nearly all of such a commit's time on a large record (T-120). A copy
    /// of the metadata is changed and bound to the held Turns, which are
    /// only read; the write is planned from that copy and those Turns; once
    /// it has committed, the copy replaces the held metadata under the
    /// record's write lock together with the change's rev and brief, so a
    /// reader sees the record before or after the change, and a write that
    /// fails leaves it as it was. A record not held, one kept as one body, a
    /// change after which `message_content::restore` would change an Item,
    /// and `turn/completed` (checked against the journal) are committed by
    /// `commit` instead, with the change already made, under the same lock.
    fn commit_meta<T>(
        &self,
        id: &str,
        kind: &str,
        data: &Value,
        mutate: impl FnOnce(&mut Meta<'_>),
        pick: impl FnOnce(&AgentDetail, Option<String>) -> T,
    ) -> Result<(u64, T)> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        let Some(held) = self.held(id).filter(|_| kind != "turn/completed") else {
            return self.commit_locked(id, kind, data, Scope::Meta, |d| mutate(&mut Meta::of(d)), pick);
        };
        let unwritten = self.memory.lock().unwrap().held.get(id).map(|held| held.unwritten.clone()).unwrap_or_default();
        let mut meta = meta_of(&held.read());
        mutate(&mut Meta::of(&mut meta));
        let restores = {
            let d = held.read();
            crate::message_content::bind_receipts(&d.turns, &mut meta.message_receipts);
            crate::message_content::restoring(&d.turns, &meta.message_receipts, false)
        };
        meta.agent.pending_count = meta.pending.len() as u64;
        meta.agent.updated_at = now();
        let plan = if restores {
            None
        } else {
            let db = self.db.read()?;
            record_rows::plan_parts(&db, id, &held.read().turns, &meta, &unwritten)?
        };
        let Some(plan) = plan else {
            return self.commit_locked(id, kind, data, Scope::Meta, move |d| put_meta(d, meta), pick);
        };
        #[cfg(test)]
        META_IN_PLACE.with(|n| n.set(n.get() + 1));
        let rewrite;
        let project_id = {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            tx.execute(
                "INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,?2,?3,?4)",
                params![id, kind, data.to_string(), now()],
            )?;
            meta.agent.last_seq = tx.last_insert_rowid();
            meta.agent.unread_count = unread(&tx, id, meta.agent.reviewed_seq)?;
            record_rows::apply(&tx, id, &plan, &meta.agent)?;
            let project_id = crate::projects::agent_project(&tx, id)?;
            tx.commit()?;
            #[cfg(test)]
            AFTER_COMMIT.with(|hook| if let Some(hook) = hook.borrow_mut().as_mut() { hook() });
            project_id
        };
        drop(plan);
        // Nothing after the commit can fail. The held copy's write lock is
        // taken before `memory` (in `done`); nothing holding `memory` ever
        // waits for a held copy's lock.
        let mut d = held.write();
        put_meta(&mut d, meta);
        let mut listed = brief(&d);
        let rev = rewrite.done(|memory| {
            let rev = memory.event(id, kind, data);
            listed.agent.rev = rev;
            memory.briefs.insert(id.into(), listed);
            if let Some(entry) = memory.held.get_mut(id).filter(|entry| Arc::ptr_eq(&entry.detail, &held)) {
                // Written, like the copy `commit` holds after its write; a
                // brief rebuilt from the copy before this change is not kept.
                entry.unwritten = Dirty::default();
                entry.unwritten_since = None;
                entry.ephemeral = false;
                entry.last = Instant::now();
                entry.brief_stale = false;
                entry.changes += 1;
            }
            rev
        });
        d.agent.rev = rev;
        let d = parking_lot::RwLockWriteGuard::downgrade(d);
        Ok((rev, pick(&d, project_id)))
    }

    pub fn review(&self, id: &str, through: i64) -> Result<bool> {
        let lock = self.record_lock(id);
        let _record = lock.lock();
        // While text streams, an open conversation is marked read after every
        // refresh. Mark the held copy; it is written with its deltas.
        if let Some(detail) = self.held(id) {
            let (last_seq, reviewed_seq) = {
                let d = detail.read();
                (d.agent.last_seq, d.agent.reviewed_seq)
            };
            let reviewed = through.min(last_seq).max(reviewed_seq);
            if reviewed == reviewed_seq { return Ok(false); }
            let unread = {
                let mut db = self.db.write()?;
                let tx = db.unsynced().transaction()?;
                let unread = unread(&tx, id, reviewed)?;
                tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'workspace/reviewed',?2,?3)",
                    params![id,json!({"throughSeq":reviewed}).to_string(),now()])?;
                tx.commit()?;
                unread
            };
            // Its rev first, then set with the change (see `record_stream`).
            let rev = self.memory.lock().unwrap().changed(id);
            {
                let mut d = detail.write();
                d.agent.reviewed_seq = reviewed;
                d.agent.unread_count = unread;
                d.agent.rev = rev;
            }
            let mut memory = self.memory.lock().unwrap();
            if let Some(held) = memory.held.get_mut(id) {
                held.unwritten_since.get_or_insert_with(Instant::now);
                held.brief_stale = true;
                held.changes += 1;
            }
            return Ok(true);
        }
        // Already read (the usual case for an open conversation): decided from
        // the listed view, which every write keeps current, without the record.
        if let Some(listed) = self.memory.lock().unwrap().briefs.get(id) {
            if through.min(listed.agent.last_seq).max(listed.agent.reviewed_seq) == listed.agent.reviewed_seq {
                return Ok(false);
            }
        }
        // A read mark changes the metadata only: the Turns are not loaded
        // unless the journal has something for them the rows lack. A damaged
        // record is not marked either: one found so in this process, or
        // whose rows do not fit together (checked without parsing them).
        let (meta, alone) = {
            let db = self.db.read()?;
            let known = self.memory.lock().unwrap().damaged.contains(id);
            if known || !record_rows::rows_fit(&db, id)? {
                let error = anyhow::Error::new(Damaged { agent: id.into(), cause: "its rows do not fit together".into() });
                let note = damage_note(&db, error.downcast_ref::<Damaged>().expect("just made"), None);
                drop(db);
                self.list_damaged(id, &error);
                return Err(error.context(note));
            }
            let meta = record_rows::load_meta(&db, id)?.context("Agent 不存在")?;
            let alone = record_rows::layout(&db, id)? == Some(Layout::Rows) && !replays(&db, id, meta.agent.last_seq)?;
            (meta, alone)
        };
        if alone {
            let mut d = meta;
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
                tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'workspace/reviewed',?2,?3)",
                    params![id,json!({"throughSeq":reviewed}).to_string(),now()])?;
                record_rows::write_meta(&tx, id, &body, &d.agent)?;
                tx.commit()?;
            }
            rewrite.done(|memory| {
                let rev = memory.changed(id);
                if let Some(listed) = memory.briefs.get_mut(id) {
                    listed.agent.reviewed_seq = reviewed;
                    listed.agent.unread_count = d.agent.unread_count;
                    listed.agent.rev = rev;
                }
            });
            return Ok(true);
        }
        let (mut d, replayed) = load(&*self.db.read()?, id)?;
        let reviewed = through.min(d.agent.last_seq).max(d.agent.reviewed_seq);
        if reviewed == d.agent.reviewed_seq { return Ok(false); }
        d.agent.reviewed_seq = reviewed;
        let plan = record_rows::plan(&*self.db.read()?, id, &d, &replayed)?;
        let rewrite;
        {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            d.agent.unread_count = unread(&tx, id, reviewed)?;
            tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,'workspace/reviewed',?2,?3)",
                params![id,json!({"throughSeq":reviewed}).to_string(),now()])?;
            // Reading is not new conversation content. Advancing last_seq here
            // would make automatic review repeatedly create its own next target.
            record_rows::apply(&tx, id, &plan, &d.agent)?;
            tx.commit()?;
        }
        let mut listed = brief(&d);
        rewrite.done(|memory| {
            listed.agent.rev = memory.changed(id);
            memory.briefs.insert(id.into(), listed);
        });
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
    /// Reads only each Turn's id and status, so `turns` need no Items.
    pub fn has_unrecorded_completion(&self, id: &str, turns: &[Value]) -> Result<bool> {
        let known = self.recorded_completions(id)?;
        Ok(turns.iter().any(|turn| unrecorded_completion(turn, &known)))
    }

    /// Reconciliation checks a whole history. Read completion IDs once, instead
    /// of parsing the same journal bodies again for each historical Turn.
    pub fn record_recovered_completions(&self, id: &str, turns: &[Value]) -> Result<()> {
        let known = self.recorded_completions(id)?;
        for turn in turns {
            if unrecorded_completion(turn, &known) {
                // Keep the existing check and atomic write: a live completion
                // may have arrived since the set above was read.
                self.record_recovered_completion(id, turn)?;
            }
        }
        Ok(())
    }

    /// A reconnect can discover a completion without receiving its event.
    /// Journal it exactly once so unread/Catch-up work across disconnects too.
    pub fn record_recovered_completion(&self, id: &str, turn: &Value) -> Result<()> {
        let exists: bool = self.db.read()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM journal WHERE agent_id=?1 AND kind='turn/completed' AND json_extract(data,'$.turn.id')=?2)
                OR EXISTS(SELECT 1 FROM codex_import_turns WHERE agent_id=?1 AND turn_id=?2)",
            params![id, turn["id"].as_str()], |r| r.get(0))?;
        if exists { return Ok(()); }
        // update() still deduplicates atomically if a native event races this check.
        self.update(id, "turn/completed", &json!({"turn":turn,"recovered":true}), |_| {})?;
        Ok(())
    }

    pub fn has_error_since(&self, id: &str, seq: i64) -> Result<bool> {
        Ok(self.db.read()?.query_row(
            "SELECT EXISTS(SELECT 1 FROM journal WHERE agent_id=?1 AND seq>?2 AND kind IN ('error','runtime/error'))",
            params![id, seq], |r| r.get(0))?)
    }

    /// perf-sse: reads the Agent's record as held in memory (see `Held`),
    /// without copying it; None when it is not held. Under the record's own
    /// read lock only, never `memory`.
    pub fn peek<T>(&self, id: &str, read: impl FnOnce(&AgentDetail) -> T) -> Option<T> {
        let held = self.held(id)?;
        let detail = held.read();
        Some(read(&detail))
    }

    /// The Agent's current rev (see `Agent::rev`). Capture it when sending a
    /// native snapshot request, for `changed_items_since`.
    pub fn rev(&self, id: &str) -> u64 {
        self.memory.lock().unwrap().rev(id)
    }

    /// What changed in the Agent's record after change `rev`: a native
    /// snapshot requested at that rev is older than these and must not
    /// replace them. Covers every event, streamed output included (it has
    /// no journal seq). Item evidence is bounded; when it no longer reaches
    /// back to `rev`, `complete` is false.
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
        // Decided on a reader: under the record lock nothing else changes
        // this Agent's row or journal meanwhile.
        let detail = {
            let db = self.db.read()?;
            if db.query_row("SELECT EXISTS(SELECT 1 FROM codex_imports WHERE agent_id=?1)", [id], |r| r.get::<_,bool>(0))? {
                return Ok(false);
            }
            // The record as it is now: a held copy can have streamed output its
            // row lacks. Holding it proves nothing; what it contains does.
            let (detail, unwritten) = match self.held(id) {
                Some(held) => {
                    let unwritten = self.memory.lock().unwrap().held.get(id).map(|held| held.unwritten.clone()).unwrap_or_default();
                    (held.read().clone(), unwritten)
                }
                None => load(&db, id)?,
            };
            if detail.agent.thread_id.as_deref() != Some(thread_id)
                || detail.agent.status == "uncertain"
                || !detail.turns.is_empty()
                || !detail.pending.is_empty()
                || !detail.artifacts.is_empty()
                || detail.agent.last_message.is_some()
            {
                return Ok(false);
            }
            let mut query =
                db.prepare("SELECT kind,data FROM journal WHERE agent_id=?1 ORDER BY seq")?;
            let rows = query.query_map([id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?;
            let mut protected_birth = false;
            let mut unsafe_operation = false;
            for row in rows {
                let (kind, data) = row?;
                let data: Value = serde_json::from_str(&data)?;
                if kind == "thread/attached"
                    && data["threadId"] == thread_id
                    && data["newEmptyThread"] == true
                    && data["turnRequestJournalVersion"] == 1
                {
                    protected_birth = true;
                    unsafe_operation = false;
                    continue;
                }
                if protected_birth
                    && (kind.starts_with("turn/")
                        || kind.starts_with("item/")
                        || kind.starts_with("request")
                        || kind == "thread/replacementRequested"
                        || kind == "codex/contextReload"
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
            (detail, unwritten)
        };
        let (mut detail, unwritten) = detail;
        // The record has no Turns, Items or requests, so it is small enough
        // to plan and serialize under the writer; what a held copy had that
        // its rows lack goes along.
        let rewrite;
        {
            let mut db = self.db.write()?;
            rewrite = self.rewrite(id);
            let tx = db.transaction()?;
            tx.execute(
                "INSERT INTO journal(agent_id,kind,data,at) VALUES(?1,?2,?3,?4)",
                params![
                    id,
                    "thread/replacementRequested",
                    json!({"oldThreadId":thread_id}).to_string(),
                    now()
                ],
            )?;
            detail.agent.last_seq = tx.last_insert_rowid();
            detail.agent.updated_at = now();
            detail.agent.status = "uncertain".into();
            detail.agent.error =
                Some("正在为未使用的 Agent 重建未落盘空会话；结果确认前不会重试。".into());
            record_rows::write(&tx, id, &detail, &unwritten)?;
            tx.commit()?;
        }
        let mut listed = brief(&detail);
        rewrite.done(|memory| {
            // The row now has everything the held copy had.
            memory.held.remove(id);
            listed.agent.rev = memory.event(id, "thread/replacementRequested", &Value::Null);
            memory.briefs.insert(id.into(), listed);
        });
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
            let detail = self.detail(&a.id)?;
            for p in &detail.pending {
                items.push(json!({"id":p.id,"agentId":a.id,"agentName":a.name,"kind":"pending","title":if p.stale {"上次请求需重新连接确认"} else {"需要你的回应"},"body":p.params["reason"].as_str().or_else(|| p.params["command"].as_str()).unwrap_or("打开对话查看完整请求"),"turnId":p.params["turnId"],"seq":a.last_seq}));
            }
            if let Some(error) = &a.error {
                items.push(json!({"id":format!("{}:error",a.id),"agentId":a.id,"agentName":a.name,"kind":"error","title":"执行需要检查","body":error,"seq":a.last_seq}));
            }
            // Bind results to *unread completed Turns*, not to unrelated unread
            // approvals or errors. A historical final is not a new result.
            for (seq, event) in self.unread_completions(&a.id, a.reviewed_seq)? {
                let id = &event["turn"]["id"];
                let Some(turn) = detail.turns.iter().find(|t| t["id"] == *id) else {
                    continue;
                };
                let result = turn["items"].as_array().and_then(|items| {
                    items
                        .iter()
                        .rev()
                        .find(|i| i["type"] == "agentMessage" && i["phase"] == "final_answer")
                });
                if let Some(item) = result {
                    let title = crate::rail::task(turn).map_or_else(|| "本轮回复".into(), |s| s.text);
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
        Ok(
            json!({"generatedAt":now(),"items":items,"source":"records","coverage":{"fromSeq":if from==i64::MAX {0}else{from},"toSeq":to}}),
        )
    }

    fn unread_completions(&self, id: &str, reviewed: i64) -> Result<Vec<(i64, Value)>> {
        let db = self.db.read()?;
        let mut q=db.prepare("SELECT seq,data FROM journal WHERE agent_id=?1 AND seq>?2 AND kind='turn/completed' ORDER BY seq")?;
        let rows = q.query_map(params![id, reviewed], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.map(|r| {
            let (seq, text) = r?;
            Ok((seq, serde_json::from_str(&text)?))
        })
        .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::ClaudeRuntime;

    pub(super) fn lab() -> (tempfile::TempDir, Store) {
        // On disk, next to the build: /tmp is memory here. The folder may
        // not exist when CARGO_TARGET_DIR points elsewhere.
        let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
        std::fs::create_dir_all(parent).unwrap();
        let dir = tempfile::tempdir_in(parent).unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        (dir, store)
    }

    pub(super) fn detail(id: &str) -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"m","color":"sage",
            "threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[{"id":"t","status":"inProgress","items":[]}],"pending":[],"artifacts":[]})).unwrap()
    }

    pub(super) fn stream(store: &Store, id: &str, kind: &str, data: &Value) -> Streamed {
        store.record_stream(id, route(kind, data), kind, data).unwrap()
    }

    fn delta(store: &Store, id: &str, text: &str) {
        stream(store, id, "item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":text}));
    }

    #[test]
    fn update_probe_activity_tracks_same_size_metadata_changes_and_cold_turns() {
        let (_dir, store) = lab();
        let mut d = detail("a");
        d.agent.status = "idle".into();
        d.turns = vec![json!({"status":"inProgress","items":[]}), json!({"id":"latest","status":"completed","items":[]})];
        d.pending.push(serde_json::from_value(json!({"id":"p","agentId":"a","method":"approval","params":{},"createdAt":"","stale":true})).unwrap());
        d.message_receipts.push(serde_json::from_value(json!({"input":{"clientMessageId":"m","text":""},"status":"accepted"})).unwrap());
        store.insert(&d).unwrap();
        assert_eq!(store.update_readiness("a").unwrap().1, Activity { running: true, ..Activity::default() });
        store.record_event("a", "test/pending", &json!({}), |d| {
            d.pending[0].stale = false;
            d.message_receipts[0].status = "sending".into();
        }).unwrap();
        let active = Activity { pending: true, sending: true, running: true, uncertain: false };
        assert_eq!(store.update_readiness("a").unwrap().1, active);
        // A cold listed view has every Turn's status, including an older Turn
        // with no ID. It does not infer idleness from active_turn: Option<id>.
        {
            let mut memory = store.memory.lock().unwrap();
            memory.held.clear();
            memory.briefs.clear();
        }
        assert_eq!(store.update_readiness("a").unwrap().1, active);
        store.record_event("a", "test/uncertain", &json!({}), |d| {
            d.pending[0].stale = true;
            d.message_receipts[0].status = "uncertain".into();
            d.turns[0]["status"] = json!("completed");
        }).unwrap();
        assert_eq!(store.update_readiness("a").unwrap().1, Activity { uncertain: true, ..Activity::default() });
        store.record_event("a", "test/settled", &json!({}), |d| d.message_receipts[0].status = "accepted".into()).unwrap();
        // Deferred native output invalidates and rebuilds the held brief.
        stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"latest","itemId":"reply","delta":"output"}));
        assert_eq!(store.update_readiness("a").unwrap().1, Activity::default());
    }

    #[test]
    fn update_probe_skips_old_payloads_but_keeps_records_verification_and_known_damage_guard() {
        let (dir, store) = lab();
        let mut d = detail("a");
        d.agent.status = "idle".into();
        d.turns[0]["status"] = json!("completed");
        d.turns[0]["items"] = json!([{"id":"command","type":"commandExecution","status":"completed","aggregatedOutput":"payload\n".repeat(2000)}]);
        d.turns.push(json!({"id":"latest","status":"completed","items":[]}));
        store.insert(&d).unwrap();
        store.memory.lock().unwrap().briefs.clear();
        assert!(store.db.write().unwrap().execute("UPDATE agent_payloads SET data='not json' WHERE agent_id='a'", []).unwrap() > 0);
        // Cold readiness does not load old payloads. This is only an idle
        // check; the mandatory boundary verifier still rejects the damage.
        assert_eq!(store.update_readiness("a").unwrap().1, Activity::default());
        let identity = store.workspace_id().unwrap();
        assert!(crate::updates::storage::verify_at(dir.path(), &identity).is_err());
        assert_eq!(store.detail("a").unwrap().agent.status, "error");
        assert!(store.update_readiness("a").unwrap_err().to_string().contains("damaged records"));
    }

    #[test]
    fn update_probe_does_not_accept_cached_idle_after_a_commit() {
        let (_dir, store) = shared();
        let mut d = detail("a");
        d.agent.status = "idle".into();
        d.turns.clear();
        store.insert(&d).unwrap();
        assert_eq!(store.update_readiness("a").unwrap().1, Activity::default());
        let (committed_tx, committed) = std::sync::mpsc::channel();
        let (go_tx, go) = std::sync::mpsc::channel();
        let writer = std::thread::spawn({
            let store = store.clone();
            move || {
                AFTER_COMMIT.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
                    committed_tx.send(()).unwrap();
                    go.recv_timeout(Duration::from_secs(10)).unwrap();
                })));
                store.record_event("a", "test/started", &json!({}), |d| {
                    d.turns.push(json!({"id":"new","status":"inProgress","items":[]}));
                }).unwrap()
            }
        });
        committed.recv_timeout(Duration::from_secs(10)).unwrap();
        let (read_tx, read_rx) = std::sync::mpsc::channel();
        let reader = std::thread::spawn({
            let store = store.clone();
            move || { read_tx.send(store.update_readiness("a")).unwrap(); }
        });
        let premature = read_rx.recv_timeout(Duration::from_millis(50));
        go_tx.send(()).unwrap();
        let rev = writer.join().unwrap();
        reader.join().unwrap();
        assert!(matches!(premature, Err(std::sync::mpsc::RecvTimeoutError::Timeout)), "a committed turn must not be reported idle from the previous cache");
        let (agent, activity) = read_rx.recv().unwrap().unwrap();
        assert_eq!(agent.rev, rev);
        assert!(activity.running);
    }

    #[test]
    fn request_holders_follow_live_changes_and_cold_metadata() {
        let (dir, store) = lab();
        for (id, request) in [("a", "shared"), ("b", "shared"), ("c", "other")] {
            let mut d = detail(id);
            d.pending.push(serde_json::from_value(json!({"id":request,"agentId":id,
                "method":"item/tool/requestUserInput","params":{},"createdAt":""})).unwrap());
            store.insert(&d).unwrap();
        }
        let owners = || store.request_holders("shared").unwrap().into_iter().map(|a|a.id).collect::<Vec<_>>();
        assert_eq!(owners(), ["a", "b"]);
        delta(&store, "a", "streaming rebuilds the brief");
        assert_eq!(owners(), ["a", "b"]);
        store.update("a", "test/resolved", &json!({}), |d| d.pending.clear()).unwrap();
        assert_eq!(owners(), ["b"]);
        store.update("b", "agent/closed", &json!({}), |d| d.agent.closed_at = Some(now())).unwrap();
        assert!(owners().is_empty());
        store.delete_closed_agent("b").unwrap();
        drop(store);
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        assert!(store.request_holders("shared").unwrap().is_empty());
        assert_eq!(store.request_holders("other").unwrap()[0].id, "c");
        // Reopening makes Pending stale. It must still be located so the
        // responder's connection validation, rather than the index, decides.
        assert!(store.detail("c").unwrap().pending[0].stale);
    }

    #[test]
    fn recovered_completion_batch_preserves_imports_read_marks_and_agent_scope() {
        let (dir, store) = lab();
        let turns = vec![
            json!({"id":"known","status":"completed","items":[]}),
            json!({"id":"imported","status":"completed","items":[]}),
            json!({"id":"failed","status":"failed","items":[]}),
            json!({"id":"interrupted","status":"interrupted","items":[]}),
            json!({"id":"running","status":"inProgress","items":[]}),
        ];
        let mut d = detail("a"); d.turns = turns.clone(); store.insert(&d).unwrap();
        store.insert(&detail("b")).unwrap();
        store.record_recovered_completion("b", &turns[2]).unwrap();
        store.record_recovered_completion("a", &turns[0]).unwrap();
        store.db.write().unwrap().execute("INSERT INTO codex_imports(agent_id,thread_id,awaiting_handoff) VALUES('a','thread',0)", []).unwrap();
        store.db.write().unwrap().execute("INSERT INTO codex_import_turns(agent_id,turn_id) VALUES('a','imported')", []).unwrap();
        store.record_recovered_completions("a", &turns).unwrap();
        let first = store.agent("a").unwrap();
        assert_eq!(first.unread_count, 3);
        store.record_recovered_completions("a", &turns).unwrap();
        assert_eq!(store.agent("a").unwrap().last_seq, first.last_seq);
        let event = json!({"turn":turns[2]});
        store.record_event("a", "turn/completed", &event, |d| d.apply("turn/completed", &event)).unwrap();
        assert_eq!(store.agent("a").unwrap().unread_count, 3);
        store.review("a", store.agent("a").unwrap().last_seq).unwrap();
        drop(store);
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        let before = store.agent("a").unwrap();
        store.record_recovered_completions("a", &turns).unwrap();
        let after = store.agent("a").unwrap();
        assert_eq!((after.last_seq, after.unread_count), (before.last_seq, 0));
    }

    #[test]
    fn concurrent_recovered_batches_still_record_a_completion_once() {
        let (_dir, store) = shared();
        let turn = json!({"id":"t","status":"completed","items":[]});
        let mut d = detail("a"); d.turns = vec![turn.clone()]; store.insert(&d).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(2));
        let threads = (0..2).map(|_| {
            let (store, barrier, turn) = (store.clone(), barrier.clone(), turn.clone());
            std::thread::spawn(move || {
                barrier.wait();
                store.record_recovered_completions("a", &[turn]).unwrap();
            })
        }).collect::<Vec<_>>();
        for thread in threads { thread.join().unwrap(); }
        assert_eq!(store.agent("a").unwrap().unread_count, 1);
        let count: i64 = store.db.read().unwrap().query_row(
            "SELECT COUNT(*) FROM journal WHERE agent_id='a' AND kind='turn/completed'", [], |r|r.get(0)).unwrap();
        assert_eq!(count, 1);
    }

    /// A Turn end written while `detail` parsed the old row must be in what it
    /// returns, or the GUI's read receipt marks the result read unseen.
    fn assert_consistent(store: &Store, seen: &AgentDetail) {
        let top: i64 = store.db.read().unwrap()
            .query_row("SELECT MAX(seq) FROM journal WHERE agent_id='a' AND kind!='workspace/reviewed'", [], |r| r.get(0)).unwrap();
        assert_eq!(seen.agent.last_seq, top);
        assert_eq!(seen.turns[0]["status"], "completed");
        assert_eq!(seen.agent.status, "idle");
        assert_eq!(seen.agent.unread_count, 1);
    }

    fn end_turn(store: &Store) {
        let completed = json!({"turn":{"id":"t","status":"completed","items":[]}});
        store.update("a", "turn/completed", &completed, |d| d.apply("turn/completed", &completed)).unwrap();
    }

    #[test]
    fn a_turn_end_written_while_the_row_is_parsed_is_not_skipped() {
        let (_dir, store) = lab();
        store.insert(&detail("a")).unwrap();
        let mut once = true;
        let seen = store.detail_racing("a", || {
            if std::mem::take(&mut once) {
                end_turn(&store);
                // Codex reports usage after the Turn ends: a deferred event.
                stream(&store, "a", "thread/tokenUsage/updated", &json!({"turnId":"t","tokenUsage":{}}));
            }
        }).unwrap();
        assert_consistent(&store, &seen);
    }

    #[test]
    fn a_row_rewritten_while_it_is_parsed_is_read_again() {
        let (_dir, store) = lab();
        store.insert(&detail("a")).unwrap();
        for n in 0..MAX_STREAMS {
            store.insert(&detail(&format!("other-{n}"))).unwrap();
        }
        let mut once = true;
        let seen = store.detail_racing("a", || {
            if std::mem::take(&mut once) {
                end_turn(&store);
                delta(&store, "a", "late text");
                // Other Agents stream, so "a" is written and leaves memory:
                // only the row and its journal remain.
                for n in 0..MAX_STREAMS {
                    delta(&store, &format!("other-{n}"), "x");
                }
                assert!(!store.memory.lock().unwrap().held.contains_key("a"));
            }
        }).unwrap();
        assert_consistent(&store, &seen);
        assert!(seen.turns[0]["items"].as_array().unwrap().iter().any(|i| i["text"] == "late text"));
    }

    #[test]
    fn replaying_the_journal_rebuilds_exactly_the_record_readers_saw() {
        let (_dir, store) = lab();
        store.insert(&detail("a")).unwrap();
        let mut c = detail("c");
        c.agent.harness = "claude".into();
        c.claude_runtime = Some(ClaudeRuntime { context_window: Some(200_000), ..Default::default() });
        store.insert(&c).unwrap();
        // Journaled events whose effect includes a time: a compaction
        // starting, token usage, a Turn first seen through its Item.
        let codex = [
            ("item/started", json!({"turnId":"t","item":{"id":"compact","type":"contextCompaction"}})),
            ("thread/tokenUsage/updated", json!({"turnId":"t","tokenUsage":{"last":{"totalTokens":1000},"modelContextWindow":200_000}})),
            ("item/started", json!({"turnId":"t2","item":{"id":"reply","type":"agentMessage","text":""}})),
            ("item/completed", json!({"turnId":"t2","item":{"id":"reply","type":"agentMessage","text":"xy"}})),
            ("hook/completed", json!({"turnId":"t","run":{"id":"stop:7"}})),
        ];
        for (kind, p) in codex {
            stream(&store, "a", kind, &p);
            std::thread::sleep(Duration::from_millis(3));
        }
        let claude = [
            json!({"type":"assistant","uuid":"b-0","message":{"id":"m","content":[{"type":"thinking","thinking":"Plan."}]}}),
            json!({"type":"assistant","uuid":"b-1","message":{"id":"m","content":[{"type":"tool_use","id":"tool","name":"Bash","input":{"command":"ls"}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool","content":"a.rs"}]}}),
            json!({"type":"system","subtype":"status","status":"requesting"}),
            json!({"type":"tool_progress","tool_use_id":"tool","elapsed_time_seconds":30}),
        ];
        for event in claude {
            stream(&store, "c", &format!("claude/{}", event["type"].as_str().unwrap()), &json!({"type":"event","turnId":"t","event":event}));
            std::thread::sleep(Duration::from_millis(3));
        }
        std::thread::sleep(Duration::from_millis(3));
        let db = store.db.read().unwrap();
        let memory = store.memory.lock().unwrap();
        assert!(memory.held["a"].detail.read().turns[0]["_yuzunoCompactionStartedAt"].is_i64());
        for id in ["a", "c"] {
            assert!(memory.held[id].unwritten_since.is_some(), "{id} still only in the journal");
            let (mut rebuilt, _) = load(&db, id).unwrap();
            // The rev belongs to this process and is never read back.
            assert_eq!(rebuilt.agent.rev, 0);
            let held = memory.held[id].detail.read();
            rebuilt.agent.rev = held.agent.rev;
            assert_eq!(serde_json::to_value(rebuilt).unwrap(), serde_json::to_value(&*held).unwrap(), "{id}");
        }
    }

    /// A background sub-agent of Claude reports after its Turn ended, in no
    /// Turn or inside another one: replaying the journal rebuilds it, and the
    /// Turn of its call is the one written with it.
    #[test]
    fn a_late_subagent_event_is_written_with_the_turn_of_its_call() {
        let (_dir, store) = lab();
        let mut c = detail("c");
        c.agent.harness = "claude".into();
        c.turns = vec![
            json!({"id":"t","status":"completed","items":[{"id":"agent-1","type":"claudeToolUse","name":"Agent","status":"completed",
                "input":{"description":"Read c.txt"},"subAgent":{"taskId":"task-1","status":"running","background":true}}]}),
            json!({"id":"t2","status":"inProgress","items":[]}),
        ];
        store.insert(&c).unwrap();
        let late = [
            (json!("t2"), json!({"type":"assistant","uuid":"s-1","parent_tool_use_id":"agent-1","message":{"id":"m-s","content":[
                {"type":"tool_use","id":"c-read","name":"Read","input":{"file_path":"c.txt"}}]}})),
            (Value::Null, json!({"type":"user","parent_tool_use_id":"agent-1","message":{"content":[{"type":"tool_result","tool_use_id":"c-read","content":"charlie"}]}})),
            (Value::Null, json!({"type":"system","subtype":"task_updated","task_id":"task-1","patch":{"status":"completed","end_time":1}})),
            (Value::Null, json!({"type":"system","subtype":"task_notification","task_id":"task-1","tool_use_id":"agent-1","status":"completed",
                "summary":"charlie","output_file":"/o"})),
        ];
        for (turn, event) in late {
            stream(&store, "c", &format!("claude/{}", event["type"].as_str().unwrap()), &json!({"type":"event","turnId":turn,"event":event}));
            std::thread::sleep(Duration::from_millis(3));
        }
        let held = store.memory.lock().unwrap().held["c"].detail.read().clone();
        assert_eq!(held.turns[0]["items"][0]["subAgent"]["status"], "completed");
        assert_eq!((held.turns[0]["items"][1]["parentToolUseId"].clone(), held.turns[0]["items"][1]["status"].clone()),
            (json!("agent-1"), json!("completed")));
        assert_eq!(held.turns[1]["items"], json!([]));
        let rebuilt = |store: &Store| {
            let (mut rebuilt, _) = load(&store.db.read().unwrap(), "c").unwrap();
            rebuilt.agent.rev = held.agent.rev;
            serde_json::to_value(rebuilt).unwrap()
        };
        assert_eq!(rebuilt(&store), serde_json::to_value(&held).unwrap(), "replayed from the journal");
        assert!(store.stream_tick(Duration::ZERO).failed.is_empty());
        assert_eq!(rebuilt(&store), serde_json::to_value(&held).unwrap(), "written to its rows");
    }

    #[test]
    fn only_the_unsynced_connection_skips_the_sync_on_commit() {
        let (_dir, store) = lab();
        store.insert(&detail("a")).unwrap();
        stream(&store, "a", "item/started", &json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":""}}));
        assert!(store.review("a", 1).unwrap());
        assert!(store.stream_tick(Duration::ZERO).failed.is_empty());
        assert_eq!((store.db.writer_synchronous(), store.db.unsynced_synchronous()), (2, 1), "FULL and NORMAL");
    }

    /// Runs `f` on another thread; true if it finished within `limit`.
    fn finishes_within(limit: Duration, f: impl FnOnce() + Send + 'static) -> bool {
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || { f(); let _ = done.send(()); });
        finished.recv_timeout(limit).is_ok()
    }

    /// Holds the writer on another thread until the returned sender is used.
    fn hold_writer(store: &Arc<Store>) -> (std::sync::mpsc::Sender<()>, std::thread::JoinHandle<()>) {
        let (held_tx, held) = std::sync::mpsc::channel();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let store = store.clone();
        let writer = std::thread::spawn(move || {
            let _db = store.db.write().unwrap();
            held_tx.send(()).unwrap();
            let _ = released.recv();
        });
        held.recv().unwrap();
        (release, writer)
    }

    fn shared() -> (tempfile::TempDir, Arc<Store>) {
        let (dir, store) = lab();
        (dir, Arc::new(store))
    }

    /// Rows are planned (serialized) before the writer; the `agent` the
    /// writer decides goes in when they are applied.
    #[test]
    fn a_record_is_written_from_rows_planned_before_the_writer() {
        let (_dir, store) = lab();
        store.insert(&detail("a")).unwrap();
        let mut d = detail("a");
        d.turns[0]["items"] = json!([{"id":"x","type":"agentMessage","text":"quote \" and {braces}"}]);
        let plan = record_rows::plan(&*store.db.read().unwrap(), "a", &d, &Dirty::all()).unwrap();
        d.agent.last_seq = 42;
        d.agent.unread_count = 3;
        {
            let mut db = store.db.write().unwrap();
            let tx = db.transaction().unwrap();
            record_rows::apply(&tx, "a", &plan, &d.agent).unwrap();
            tx.commit().unwrap();
        }
        let back = record_rows::load(&*store.db.read().unwrap(), "a", true).unwrap().unwrap();
        assert_eq!(serde_json::to_string(&back).unwrap(), serde_json::to_string(&d).unwrap());
    }

    /// A held record waiting for the writer to be written (the ticker holds
    /// its record lock, nothing else) can still be read, listed and checked,
    /// and another Agent still streams.
    #[test]
    fn a_held_record_is_read_while_it_waits_to_be_written() {
        let (_dir, store) = shared();
        store.insert(&detail("a")).unwrap();
        store.insert(&detail("b")).unwrap();
        stream(&store, "a", "item/completed", &json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":"held"}}));
        let (release, writer) = hold_writer(&store);
        let ticking = std::thread::spawn({
            let store = store.clone();
            move || store.stream_tick(Duration::ZERO)
        });
        std::thread::sleep(Duration::from_millis(50));
        let reader = store.clone();
        assert!(finishes_within(Duration::from_secs(5), move || {
            assert_eq!(reader.detail("a").unwrap().turns[0]["items"][0]["text"], "held");
            assert_eq!(reader.agent("a").unwrap().id, "a");
            assert_eq!(reader.agents().unwrap().len(), 2);
            assert!(!reader.binding("a").unwrap().0);
            reader.changed_items_since("a", 0).unwrap();
            stream(&reader, "b", "item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":"flows"}));
            assert_eq!(reader.detail("b").unwrap().turns[0]["items"][0]["text"], "flows");
        }), "reads waited for a held record's write");
        assert!(!ticking.is_finished());
        release.send(()).unwrap();
        writer.join().unwrap();
        assert!(ticking.join().unwrap().failed.is_empty());
        let row = record_rows::load(&*store.db.read().unwrap(), "a", true).unwrap().unwrap();
        assert_eq!(row.turns[0]["items"][0]["text"], "held");
    }

    /// A record held (with output its rows lack) while a payload request read
    /// its rows is answered from the held copy, not the older rows.
    #[test]
    fn a_payload_read_racing_a_stream_is_answered_from_the_held_copy() {
        let (_dir, store) = lab();
        let mut d = detail("a");
        d.turns[0]["items"] = json!([{"id":"run","type":"commandExecution","aggregatedOutput":"first\n"}]);
        store.insert(&d).unwrap();
        assert_eq!(store.streamed_records(), 0);
        let mut once = true;
        let output = store.payload_view_racing("a", None, Some("run"), |d| d.turns[0]["items"][0]["aggregatedOutput"].clone(), || {
            if std::mem::take(&mut once) {
                stream(&store, "a", "item/commandExecution/outputDelta", &json!({"turnId":"t","itemId":"run","delta":"more\n"}));
            }
        }).unwrap().unwrap();
        assert_eq!(output, "first\nmore\n");
    }

    /// A view read through a snapshot older than a delete is not kept: the
    /// deleted Agent never comes back as listed.
    #[test]
    fn a_listed_view_from_an_older_snapshot_is_not_kept() {
        let (_dir, store) = lab();
        store.insert(&detail("a")).unwrap();
        let old = store.db.read().unwrap();
        let _: i64 = old.query_row("SELECT COUNT(*) FROM agents", [], |r| r.get(0)).unwrap();
        store.update("a", "agent/closed", &json!({}), |d| d.agent.closed_at = Some(now())).unwrap();
        store.delete_closed_agent("a").unwrap();
        assert!(store.brief_in(&old, "a").unwrap().is_some(), "the old snapshot still has it");
        drop(old);
        assert!(store.agent("a").is_err());
        assert!(store.agents().unwrap().is_empty());
    }

    /// With nothing due, a tick needs no writer.
    #[test]
    fn the_ticker_takes_the_writer_only_for_a_due_record() {
        let (_dir, store) = shared();
        store.insert(&detail("a")).unwrap();
        stream(&store, "a", "item/completed", &json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":"x"}}));
        delta(&store, "a", " streaming");
        let (release, writer) = hold_writer(&store);
        let ticker = store.clone();
        assert!(finishes_within(Duration::from_secs(5), move || {
            let tick = ticker.stream_tick(Duration::from_secs(60));
            assert_eq!(tick.announce, ["a".to_string()]);
            assert!(tick.failed.is_empty());
        }), "an idle tick waited for the writer");
        release.send(()).unwrap();
        writer.join().unwrap();
    }

    /// A changed record is serialized (`record_rows::plan`) before its commit
    /// takes the writer, so a write never holds the writer while it
    /// serializes a record. Checked with the writer held by this thread: the
    /// commit must finish planning while it waits for the writer.
    #[test]
    fn records_are_serialized_before_the_writer_is_taken() {
        let (_dir, store) = lab();
        assert!(store.db.is_wal(), "a plan reads through its own snapshot only in WAL mode");
        let mut big = detail("big");
        big.turns[0]["items"] = (0..2_000).map(|n| json!({"id":format!("old-{n}"),"type":"agentMessage",
            "text":"An earlier line of output that makes this record large"})).collect();
        store.insert(&big).unwrap();
        // Once from the row and once held (streamed, not yet written).
        for held in [false, true] {
            if held {
                stream(&store, "big", "item/completed", &json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":"x"}}));
            }
            let text = format!("changed (held: {held})");
            let (planned, wait) = std::sync::mpsc::channel();
            *AFTER_PLAN.lock().unwrap() = Some(("big".into(), planned));
            std::thread::scope(|s| {
                let writer = store.db.write().unwrap();
                let commit = s.spawn(|| {
                    store.update("big", "thread/status/changed", &json!({}), |d| {
                        d.turns[0]["items"][0]["text"] = json!(text);
                    })
                });
                let planning = wait.recv_timeout(std::time::Duration::from_secs(20));
                drop(writer);
                assert!(planning.is_ok(), "the commit did not finish planning while the writer was held elsewhere (held: {held})");
                let d = commit.join().unwrap().unwrap();
                assert_eq!(d.turns[0]["items"][0]["text"], json!(text));
            });
            *AFTER_PLAN.lock().unwrap() = None;
        }
    }

    /// #1: a change and its rev are set together, so a copy read at any
    /// moment holds exactly the changes up to its rev (or SSE deltas after
    /// it would be applied twice, or skipped).
    #[test]
    fn a_copy_never_has_a_change_without_its_rev_or_the_reverse() {
        let (_dir, store) = shared();
        store.insert(&detail("a")).unwrap();
        stream(&store, "a", "item/started", &json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":""}}));
        let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let reader = std::thread::spawn({
            let (store, done) = (store.clone(), done.clone());
            move || {
                let mut seen = Vec::new();
                while !done.load(std::sync::atomic::Ordering::Relaxed) {
                    if let Some(copy) = store.peek("a", |d| (d.turns[0]["items"][0]["text"].as_str().unwrap_or("").to_owned(), d.agent.rev)) {
                        seen.push(copy);
                    }
                }
                seen
            }
        });
        let base = store.rev("a");
        let mut revs = Vec::new();
        for n in 0..3000 {
            revs.push(stream(&store, "a", "item/agentMessage/delta", &json!({"turnId":"t","itemId":"reply","delta":format!("{n},")})).rev.unwrap());
        }
        done.store(true, std::sync::atomic::Ordering::Relaxed);
        let seen = reader.join().unwrap();
        assert!(seen.len() > 100, "the reader read {} copies", seen.len());
        for (text, rev) in seen {
            let deltas = text.matches(',').count();
            let expected = if rev <= base { 0 } else { revs.iter().filter(|r| **r <= rev).count() };
            assert_eq!(deltas, expected, "a copy at rev {rev} holds {deltas} deltas");
        }
    }

    /// #2: a write committed but not yet shown in memory (its rev and
    /// version) is never read with the previous rev: the read waits for it.
    #[test]
    fn rows_read_while_a_write_is_shown_carry_its_rev() {
        let (_dir, store) = shared();
        store.insert(&detail("a")).unwrap();
        let (committed_tx, committed) = std::sync::mpsc::channel();
        let (go_tx, go) = std::sync::mpsc::channel::<()>();
        let writer = std::thread::spawn({
            let store = store.clone();
            move || {
                AFTER_COMMIT.with(|hook| *hook.borrow_mut() = Some(Box::new(move || {
                    committed_tx.send(()).unwrap();
                    go.recv().unwrap();
                })));
                store.update("a", "agent/renamed", &json!({}), |d| d.agent.name = "renamed".into()).unwrap().agent.rev
            }
        });
        committed.recv().unwrap();
        let reader = std::thread::spawn({
            let store = store.clone();
            move || store.detail("a").unwrap()
        });
        std::thread::sleep(Duration::from_millis(100));
        assert!(!reader.is_finished(), "a read of the committed rows did not wait for their rev");
        go_tx.send(()).unwrap();
        let rev = writer.join().unwrap();
        let read = reader.join().unwrap();
        assert_eq!((read.agent.name.as_str(), read.agent.rev), ("renamed", rev));
    }

    /// #3: an event whose application panics leaves no half-applied copy:
    /// the record is rebuilt from its rows and journal, the event skipped,
    /// and the Agent says so. It stays readable and writable, not Damaged.
    #[test]
    fn an_event_that_cannot_be_applied_is_skipped_and_shown() {
        let (_dir, store) = lab();
        store.insert(&detail("a")).unwrap();
        stream(&store, "a", "item/completed", &json!({"turnId":"t","item":{"id":"reply","type":"agentMessage","text":"kept"}}));
        let broken = json!({"turnId":"t","_testPanic":true,"item":{"id":"other","type":"agentMessage","text":"never"}});
        assert!(store.record_stream("a", Route::Deferred, "item/completed", &broken).is_err());
        let seq: i64 = store.db.read().unwrap().query_row("SELECT MAX(seq) FROM journal WHERE agent_id='a'", [], |r| r.get(0)).unwrap();
        // Applied after it, and replayed with it from the journal.
        stream(&store, "a", "item/completed", &json!({"turnId":"t","item":{"id":"late","type":"agentMessage","text":"after"}}));
        assert!(store.flush().failed.is_empty());
        store.memory.lock().unwrap().held.clear();
        // Written as if before both events, so loading replays them.
        let d = store.detail("a").unwrap();
        let error = d.agent.error.clone().unwrap_or_default();
        assert!(error.contains(&format!("#{seq}")) && error.contains("item/completed"), "{error}");
        assert_eq!(d.agent.name, "a", "no half-applied change");
        let texts: Vec<&str> = d.turns[0]["items"].as_array().unwrap().iter().filter_map(|i| i["text"].as_str()).collect();
        assert_eq!(texts, ["kept", "after"]);
        assert!(record_rows::load(&*store.db.read().unwrap(), "a", true).is_ok(), "its rows still assemble");
        store.update("a", "agent/noted", &json!({}), |_| {}).unwrap();
        assert!(store.detail("a").unwrap().agent.error.unwrap_or_default().contains(&format!("#{seq}")));
    }

    /// #3, replay only: an event the journal holds whose application panics
    /// (as after a crash) is skipped the same way.
    #[test]
    fn a_journaled_event_that_cannot_be_replayed_is_skipped_and_shown() {
        let (_dir, store) = lab();
        store.insert(&detail("a")).unwrap();
        {
            let mut db = store.db.write().unwrap();
            let tx = db.transaction().unwrap();
            for (kind, data) in [
                ("item/completed", json!({"turnId":"t","item":{"id":"one","type":"agentMessage","text":"one"}})),
                ("item/completed", json!({"turnId":"t","_testPanic":true,"item":{"id":"bad","type":"agentMessage","text":"x"}})),
                ("item/completed", json!({"turnId":"t","item":{"id":"two","type":"agentMessage","text":"two"}})),
            ] {
                tx.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a',?1,?2,?3)", params![kind, data.to_string(), now()]).unwrap();
            }
            tx.commit().unwrap();
        }
        let d = store.detail("a").unwrap();
        assert!(d.agent.error.unwrap_or_default().contains("item/completed"));
        let texts: Vec<&str> = d.turns[0]["items"].as_array().unwrap().iter().filter_map(|i| i["text"].as_str()).collect();
        assert_eq!(texts, ["one", "two"]);
        assert_eq!(d.agent.status, "working", "readable as it is, not a damaged stand-in");
    }

    /// #4: first events of more Agents than MAX_STREAMS at once: the bound
    /// holds once they are done (by the next tick at the latest), and every
    /// record dropped was written first.
    #[test]
    fn held_records_stay_bounded_when_many_agents_start_streaming_at_once() {
        let (_dir, store) = shared();
        let ids: Vec<String> = (0..MAX_STREAMS + 4).map(|n| format!("agent-{n}")).collect();
        for id in &ids {
            store.insert(&detail(id)).unwrap();
        }
        let barrier = Arc::new(std::sync::Barrier::new(ids.len()));
        let threads: Vec<_> = ids.iter().map(|id| {
            let (store, barrier, id) = (store.clone(), barrier.clone(), id.clone());
            std::thread::spawn(move || {
                barrier.wait();
                delta(&store, &id, &format!("text of {id}"));
            })
        }).collect();
        for thread in threads {
            thread.join().unwrap();
        }
        store.stream_tick(Duration::from_secs(60));
        assert!(store.streamed_records() <= MAX_STREAMS, "{} held", store.streamed_records());
        for id in &ids {
            assert_eq!(store.detail(id).unwrap().turns[0]["items"][0]["text"], format!("text of {id}"));
        }
    }

    /// #7: a deleted Agent's record lock is let go, and so are idle ones.
    #[test]
    fn record_locks_are_let_go() {
        let (_dir, store) = lab();
        store.insert(&detail("a")).unwrap();
        store.insert(&detail("b")).unwrap();
        delta(&store, "b", "x");
        store.update("a", "agent/closed", &json!({}), |d| d.agent.closed_at = Some(now())).unwrap();
        store.delete_closed_agent("a").unwrap();
        assert!(!store.records.lock().unwrap().contains_key("a"));
        store.stream_tick(Duration::from_secs(60));
        assert!(store.records.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod window_tests;
#[cfg(test)]
mod scoped_tests;
