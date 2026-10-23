//! Live changes for clients: `GET /api/events` (server-sent events).
//!
//! # Protocol
//!
//! - Every message has `id: <epoch>-<n>`. `epoch` names this Core process
//!   start; `n` counts the messages Core has published since then (1, 2, …),
//!   across all Agents.
//! - Core keeps the latest messages ([`RING_EVENTS`], at most [`RING_BYTES`]).
//!   A client that reconnects with `Last-Event-ID` (browsers send it on their
//!   own reconnects; `?lastEventId=` works too) from this epoch, still in that
//!   buffer, first gets `{"type":"resumed"}` (no id), then every message after
//!   that id, in order. Otherwise the first message is `reset`: the client
//!   must refetch everything it shows. A fresh connection starts with `reset`.
//! - Each client has its own queue ([`SUBSCRIBER_QUEUE`] messages and
//!   [`SUBSCRIBER_BYTES`]). Core never waits for a client: one that falls
//!   that far behind gets `reset` and continues live from there.
//! - `event: heartbeat` every [`HEARTBEAT`], without an id, so a client can
//!   tell a quiet stream from a dead one.
//!
//! `data` is JSON with a `type`:
//!
//! - `agent.delta` `{agentId, rev, turnId, itemId, op:"append", field, index?, text}`:
//!   append `text` to the Item's string `field`, or with `index`, to element
//!   `index` of its array of strings (padded with "" up to it).
//! - `agent.item` `{agentId, rev, turnId, item, artifacts?}`: the Item as it
//!   is now, inserted or replacing the one with its id. `artifacts`, when
//!   present, is the Agent's whole artifact list.
//! - `agent.context` `{agentId, rev, contextUsage?, claudeRuntime?}`: the
//!   Agent's context usage, or the facts its Claude runtime reports (rate
//!   limits), whichever is present.
//! - `agent.changed` `{agentId, rev, lastSeq}`: anything else about one Agent
//!   (Turns starting or ending, status, requests, settings, read state,
//!   mailbox delivery, …). Refetch what you show of it.
//! - `agent.progress` `{agentId, rev, lastSeq, agent}`: streamed progress was
//!   applied (and already sent as the messages above); `agent` is its listed
//!   entry (rail) now, without `projectId`. At most every 250 ms per Agent.
//! - `workspace.changed` `{scope, <scope>: true}`: `collaboration`,
//!   `projects`, `machines` or `runtime`.
//! - `reset` `{refresh: true, reason}` and `resumed` `{from}`, as above.
//!
//! `rev` is the Agent record's revision once that change is applied (see
//! `model::Agent::rev`; every change, streamed output included, takes the
//! next value of one counter in this Core process), and a detail or listed
//! Agent carries the one it reflects in `agent.rev`: a detail with
//! `agent.rev >= rev` already contains the change. Messages for one Agent's
//! Items arrive in `rev` order; several may share one `rev` (one native
//! event). Revisions mean nothing across a restart; a new process has a new
//! epoch, so clients reset. `lastSeq` is the journal position, for read
//! receipts only. Events kept only as evidence, and ignored ones, change
//! nothing and send nothing.
//! Older clients keep working: every Agent message has `agentId`, `reset` has
//! `refresh: true`, and workspace messages keep their `<scope>: true` field.
//!
//! [`client_item`] is the one place an Item is shaped for these messages.

use crate::{model::{AgentDetail, PendingRequest}, workspace::Workspace};
use axum::response::sse::Event as Sse;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    convert::Infallible,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex, Weak,
    },
    time::Duration,
};
use tokio::sync::mpsc;

/// Messages kept for resuming clients.
pub const RING_EVENTS: usize = 10_000;
/// Bytes of message data kept for resuming clients (the newest message is
/// always kept, whatever its size).
pub const RING_BYTES: usize = 32 * 1024 * 1024;
/// Messages queued for one client before it is reset instead.
pub const SUBSCRIBER_QUEUE: usize = 4096;
/// Bytes queued for one client before it is reset instead.
pub const SUBSCRIBER_BYTES: usize = 16 * 1024 * 1024;
pub const HEARTBEAT: Duration = Duration::from_secs(15);

/// One published message, encoded once for every client.
pub struct Entry {
    pub n: u64,
    pub data: String,
}

/// What one client's queue holds, shared by the hub and its stream.
#[derive(Default)]
struct Queue {
    overflowed: AtomicBool,
    bytes: AtomicUsize,
}

struct Subscriber {
    tx: mpsc::Sender<Arc<Entry>>,
    queue: Arc<Queue>,
}

#[derive(Default)]
struct Hub {
    head: u64,
    ring: VecDeque<Arc<Entry>>,
    bytes: usize,
    subscribers: Vec<Subscriber>,
    closed: bool,
}

pub struct Events {
    epoch: String,
    hub: Mutex<Hub>,
}

/// How a new connection starts.
#[derive(Debug, PartialEq)]
pub enum Start {
    /// Everything after the client's last id, in order.
    Resumed { from: String, replay: Vec<Arc<Entry>> },
    /// The client must refetch; it continues after `head`.
    Reset { head: u64, reason: &'static str },
}

impl std::fmt::Debug for Entry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "#{} {}", self.n, self.data)
    }
}
impl PartialEq for Entry {
    fn eq(&self, other: &Self) -> bool {
        self.n == other.n && self.data == other.data
    }
}

pub struct Subscription {
    pub start: Start,
    rx: mpsc::Receiver<Arc<Entry>>,
    queue: Arc<Queue>,
}

impl Subscription {
    /// True once Core dropped this client for falling behind.
    pub fn overflowed(&self) -> bool {
        self.queue.overflowed.load(Ordering::Acquire)
    }

    /// The next queued message, if any (tests; the stream uses `recv`).
    pub fn try_next(&mut self) -> Option<Arc<Entry>> {
        let entry = self.rx.try_recv().ok()?;
        self.queue.bytes.fetch_sub(entry.data.len(), Ordering::AcqRel);
        Some(entry)
    }

    async fn recv(&mut self) -> Option<Arc<Entry>> {
        let entry = self.rx.recv().await?;
        self.queue.bytes.fetch_sub(entry.data.len(), Ordering::AcqRel);
        Some(entry)
    }
}

impl Default for Events {
    fn default() -> Self {
        Self::new()
    }
}

impl Events {
    pub fn new() -> Self {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis());
        let salt = &uuid::Uuid::new_v4().simple().to_string()[..6];
        Self { epoch: format!("{millis:x}{salt}"), hub: Mutex::default() }
    }

    pub fn epoch(&self) -> &str {
        &self.epoch
    }

    pub fn id(&self, n: u64) -> String {
        format!("{}-{n}", self.epoch)
    }

    /// The last published message number.
    pub fn head(&self) -> u64 {
        self.hub.lock().unwrap().head
    }

    /// Publishes one message to every client and the resume buffer. Never
    /// waits for a client. Returns its number (0 once closed).
    pub fn publish(&self, value: &Value) -> u64 {
        // Encoded outside the lock; a large Item must not hold up others.
        let mut data = value.to_string();
        // The ring and client queues keep it and count its length; encoding
        // left up to as much again reserved beyond that.
        data.shrink_to_fit();
        let mut hub = self.hub.lock().unwrap();
        if hub.closed {
            return 0;
        }
        hub.head += 1;
        let entry = Arc::new(Entry { n: hub.head, data });
        let size = entry.data.len();
        hub.bytes += size;
        hub.ring.push_back(entry.clone());
        while hub.ring.len() > RING_EVENTS || (hub.bytes > RING_BYTES && hub.ring.len() > 1) {
            let old = hub.ring.pop_front().unwrap();
            hub.bytes -= old.data.len();
        }
        hub.subscribers.retain(|s| {
            // A client holding this much (even messages the ring dropped) is
            // reset rather than kept behind.
            if s.queue.bytes.load(Ordering::Acquire) + size > SUBSCRIBER_BYTES {
                s.queue.overflowed.store(true, Ordering::Release);
                return false;
            }
            match s.tx.try_send(entry.clone()) {
                Ok(()) => {
                    s.queue.bytes.fetch_add(size, Ordering::AcqRel);
                    true
                }
                Err(mpsc::error::TrySendError::Full(_)) => {
                    // Its stream sends `reset` and continues from a new queue.
                    s.queue.overflowed.store(true, Ordering::Release);
                    false
                }
                Err(mpsc::error::TrySendError::Closed(_)) => false,
            }
        });
        entry.n
    }

    /// The pre-delta notices (`{"collaboration":true}`, `{"agentId":…}`, …)
    /// as typed messages that keep their old fields.
    pub fn send(&self, mut value: Value) -> u64 {
        if value.get("type").is_none() {
            let typed = if value.get("agentId").is_some() {
                json!({"type":"agent.changed"})
            } else if value.get("refresh").is_some() {
                json!({"type":"reset","reason":"refresh"})
            } else {
                let scope = ["collaboration", "projects", "machines", "runtime"]
                    .into_iter()
                    .find(|s| value.get(*s).is_some())
                    .unwrap_or("workspace");
                json!({"type":"workspace.changed","scope":scope})
            };
            if let (Some(value), Some(typed)) = (value.as_object_mut(), typed.as_object()) {
                for (key, field) in typed {
                    value.insert(key.clone(), field.clone());
                }
            }
        }
        self.publish(&value)
    }

    /// Starts a client after `last_event_id`, atomically with its first live
    /// message: nothing is lost or sent twice between the replay and the queue.
    pub fn subscribe(&self, last_event_id: Option<&str>) -> Subscription {
        let (tx, rx) = mpsc::channel(SUBSCRIBER_QUEUE);
        let queue = Arc::new(Queue::default());
        let mut hub = self.hub.lock().unwrap();
        let after = last_event_id.map(|id| {
            id.trim()
                .rsplit_once('-')
                .filter(|(epoch, _)| *epoch == self.epoch)
                .and_then(|(_, n)| n.parse::<u64>().ok())
        });
        let start = match after {
            None => Start::Reset { head: hub.head, reason: "new" },
            Some(None) => Start::Reset { head: hub.head, reason: "epoch" },
            Some(Some(n)) if n > hub.head => Start::Reset { head: hub.head, reason: "unknown" },
            Some(Some(n)) if n == hub.head => Start::Resumed { from: self.id(n), replay: Vec::new() },
            Some(Some(n)) => match hub.ring.front() {
                // Numbers are contiguous in the ring, so this is a slice.
                Some(first) if first.n <= n + 1 => Start::Resumed {
                    from: self.id(n),
                    replay: hub.ring.iter().skip((n + 1 - first.n) as usize).cloned().collect(),
                },
                _ => Start::Reset { head: hub.head, reason: "expired" },
            },
        };
        if !hub.closed {
            hub.subscribers.push(Subscriber { tx, queue: queue.clone() });
        }
        Subscription { start, rx, queue }
    }

    /// Ends every stream (for shutdown); later messages are dropped.
    pub fn close(&self) {
        let mut hub = self.hub.lock().unwrap();
        hub.closed = true;
        hub.subscribers.clear();
    }

    fn closed(&self) -> bool {
        self.hub.lock().unwrap().closed
    }

    /// Connected clients.
    pub fn subscribers(&self) -> usize {
        self.hub.lock().unwrap().subscribers.len()
    }

    /// The server-sent event stream for one client.
    pub fn stream(
        self: &Arc<Self>,
        last_event_id: Option<&str>,
    ) -> impl futures_util::Stream<Item = Result<Sse, Infallible>> + Send + 'static {
        let mut subscription = self.subscribe(last_event_id);
        let first = std::mem::replace(&mut subscription.start, Start::Reset { head: 0, reason: "" });
        let mut heartbeat = tokio::time::interval_at(tokio::time::Instant::now() + HEARTBEAT, HEARTBEAT);
        heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let reader = Reader {
            hub: Arc::downgrade(self),
            epoch: self.epoch.clone(),
            first: Some(first),
            replay: VecDeque::new(),
            subscription,
            heartbeat,
        };
        futures_util::stream::unfold(reader, |mut r| async move {
            let event = r.next().await?;
            Some((Ok(event), r))
        })
    }
}

struct Reader {
    hub: Weak<Events>,
    epoch: String,
    first: Option<Start>,
    replay: VecDeque<Arc<Entry>>,
    subscription: Subscription,
    heartbeat: tokio::time::Interval,
}

impl Reader {
    fn frame(&self, entry: &Entry) -> Sse {
        Sse::default().id(format!("{}-{}", self.epoch, entry.n)).data(&entry.data)
    }

    fn start(&mut self, start: Start) -> Sse {
        let retry = Duration::from_secs(1);
        match start {
            Start::Resumed { from, replay } => {
                self.replay = replay.into();
                Sse::default().retry(retry).data(json!({"type":"resumed","from":from}).to_string())
            }
            Start::Reset { head, reason } => Sse::default()
                .retry(retry)
                .id(format!("{}-{head}", self.epoch))
                .data(json!({"type":"reset","refresh":true,"reason":reason}).to_string()),
        }
    }

    async fn next(&mut self) -> Option<Sse> {
        if let Some(start) = self.first.take() {
            return Some(self.start(start));
        }
        loop {
            if self.subscription.overflowed() {
                // What is still queued is superseded by the reset.
                let hub = self.hub.upgrade()?;
                let subscription = hub.subscribe(None);
                let Start::Reset { head, .. } = subscription.start else { unreachable!() };
                self.subscription = subscription;
                self.replay.clear();
                return Some(self.start(Start::Reset { head, reason: "overflow" }));
            }
            if let Some(entry) = self.replay.pop_front() {
                return Some(self.frame(&entry));
            }
            tokio::select! {
                entry = self.subscription.recv() => match entry {
                    Some(entry) => {
                        if self.subscription.overflowed() { continue; }
                        return Some(self.frame(&entry));
                    }
                    None => {
                        let hub = self.hub.upgrade()?;
                        if hub.closed() { return None; }
                        // Dropped for falling behind (the flag is set first).
                        self.subscription.queue.overflowed.store(true, Ordering::Release);
                    }
                },
                _ = self.heartbeat.tick() => {
                    return Some(Sse::default().event("heartbeat").data("{\"type\":\"heartbeat\"}"));
                }
            }
        }
    }
}

/// An Item as clients receive it, in `agent.item`: the detail API's
/// projection (`client_view::item`), so a large tool field arrives as the
/// same bounded preview with `_yuzunoTruncated` (never a whole
/// `aggregatedOutput`), and Items a pending request refers to stay whole.
/// Streamed output then appends to that preview on the client (see
/// web/src/detail-patch.ts).
pub fn client_item(item: &Value, pending: &[PendingRequest]) -> Value {
    crate::client_view::item(item, pending)
}

/// One message a streamed change produces for clients.
#[derive(Debug, PartialEq)]
pub enum Out {
    /// Append `text` to the Item's string `field`, or to element `index`.
    Append { item: String, field: &'static str, index: Option<usize>, text: String },
    /// The Item as it is now, with the artifact list when it may have grown.
    Item(Value, Option<Value>),
    /// Top-level detail fields, replaced whole: `contextUsage`,
    /// `claudeRuntime`.
    Context(Value),
    /// Something only a refetch shows.
    Changed,
}

fn find_item<'a>(turn: &'a Value, id: &str) -> Option<&'a Value> {
    turn["items"].as_array()?.iter().find(|i| i["id"] == id)
}

/// What a Claude progress event (`stream_event`, `assistant`, `user`, a
/// sub-agent's task event) changed, from the record after `project_event`
/// applied it and the event itself, in the Turn `claude::event_turn` found
/// for it. Mirrors `project_event`. Text and thinking deltas become appends
/// computed from the delta and the Turn's stream state, so each costs about
/// the delta, not the message; an Item goes out whole only when it starts,
/// is confirmed or its tool input or result arrives.
pub fn claude_changes(d: &AgentDetail, turn_id: Option<&str>, event: &Value) -> Vec<Out> {
    // A session that is not this Agent's marks it uncertain (with or
    // without a Turn).
    if let Some(session) = event["session_id"].as_str().filter(|s| !s.is_empty()) {
        if d.agent.claude_session_id.as_deref() != Some(session) {
            return vec![Out::Changed];
        }
    }
    // Rate limits are the runtime's, reported with or without a Turn.
    if event["type"] == "rate_limit_event" {
        return if event["rate_limit_info"].is_object() {
            vec![Out::Context(json!({"claudeRuntime":d.claude_runtime}))]
        } else {
            vec![]
        };
    }
    let Some(turn) = turn_id.and_then(|tid| d.turns.iter().find(|t| t["id"] == tid)) else {
        // An event for no Turn, or one Core does not have, changed nothing.
        return vec![];
    };
    let pending = &d.pending;
    let whole = |id: &str| find_item(turn, id).map(|item| Out::Item(client_item(item, pending), None));
    let subagent = event["parent_tool_use_id"].is_string();
    let mut out = Vec::new();
    match event["type"].as_str() {
        // A subagent's partial stream is not projected.
        Some("stream_event") if !subagent => {
            let e = &event["event"];
            let message = turn["_claudeMessageId"].as_str();
            let index = e["index"].as_u64().unwrap_or(0).to_string();
            match (e["type"].as_str(), e["content_block"]["type"].as_str(), e["delta"]["type"].as_str()) {
                (Some("content_block_start"), Some("text"), _) => out.extend(message.and_then(whole)),
                (Some("content_block_start"), Some("thinking"), _) => {
                    out.extend(message.and_then(|m| whole(&format!("{m}:thinking"))))
                }
                (Some("content_block_start"), Some("tool_use"), _) => {
                    out.extend(e["content_block"]["id"].as_str().and_then(whole))
                }
                (Some("content_block_delta"), _, Some("text_delta")) => {
                    if let Some(m) = message {
                        out.extend(text_delta(turn, pending, m, &index, e["delta"]["text"].as_str().unwrap_or("")));
                    }
                }
                (Some("content_block_delta"), _, Some("thinking_delta")) => {
                    if let Some(m) = message {
                        out.extend(thinking_delta(turn, pending, m, &index, e["delta"]["thinking"].as_str().unwrap_or("")));
                    }
                }
                (Some("content_block_delta"), _, Some("input_json_delta")) => {
                    // The Item takes the input only once the JSON parses,
                    // which an object or array cannot before its closing
                    // bracket. Checking that is cheap; parsing again is not.
                    let block = &turn["_claudeBlocks"][&index];
                    let closed = block["inputJson"].as_str()
                        .is_some_and(|json| json.trim_end().ends_with(['}', ']']));
                    if closed {
                        out.extend(block["id"].as_str().and_then(whole));
                    }
                }
                (Some("message_delta"), _, _) => {
                    out.push(Out::Context(json!({"contextUsage":d.context_usage})));
                }
                _ => {}
            }
        }
        Some("assistant") => {
            for id in claude_items(event) {
                out.extend(whole(&id));
            }
        }
        Some("user") => {
            let mut artifacts = false;
            let mut ended = Vec::new();
            for id in claude_items(event) {
                if let Some(Out::Item(item, _)) = whole(&id) {
                    artifacts |= matches!(item["name"].as_str(), Some("Write" | "Edit" | "MultiEdit"));
                    if item["subAgent"].is_object() {
                        ended.push(id);
                    }
                    out.push(Out::Item(item, None));
                }
            }
            if artifacts {
                if let Some(Out::Item(_, slot)) = out.first_mut() {
                    *slot = serde_json::to_value(&d.artifacts).ok();
                }
            }
            for call in ended {
                out.extend(settled_calls(turn, pending, &call));
            }
        }
        Some("system") => {
            if let Some(item) = crate::claude::task_call(turn, event)
                .filter(|item| crate::claude::TASK_RECORDS.iter().any(|key| item[*key].is_object()))
            {
                out.push(Out::Item(client_item(item, pending), None));
                if let Some(call) = item["id"].as_str() {
                    out.extend(settled_calls(turn, pending, call));
                }
            }
        }
        _ => {}
    }
    out
}

/// A sub-agent's own calls its end settled (`claude::settle_subagent_tools`).
fn settled_calls<'a>(turn: &'a Value, pending: &'a [PendingRequest], call: &'a str) -> impl Iterator<Item = Out> + 'a {
    let ended = find_item(turn, call).is_some_and(|item| {
        matches!(item["subAgent"]["status"].as_str(), Some("completed" | "failed" | "stopped"))
    });
    turn["items"].as_array().into_iter().flatten()
        .filter(move |item| ended && item["parentToolUseId"] == call && item["status"] == "unknown")
        .map(|item| Out::Item(client_item(item, pending), None))
}

/// A text delta as `stream_text` applied it: the message's text is its
/// blocks joined in order, so a delta to the last block extends it.
fn text_delta(turn: &Value, pending: &[PendingRequest], message: &str, index: &str, delta: &str) -> Option<Out> {
    if delta.is_empty() {
        return None;
    }
    let blocks = turn["_claudeTextBlocks"][message].as_array()?;
    let last = blocks.last()?;
    // The first text of a message is sent whole: the client may not have the
    // Item yet if no block start came before.
    let first = blocks.len() == 1 && last["text"].as_str().is_some_and(|t| t.len() == delta.len());
    if last["index"] == index && !first {
        return Some(Out::Append { item: message.into(), field: "text", index: None, text: delta.into() });
    }
    find_item(turn, message).map(|item| Out::Item(client_item(item, pending), None))
}

/// A thinking delta as `stream_thinking` and `render_thinking` applied it:
/// the reasoning Item's summary is each non-empty part, trimmed, in index
/// order. A delta to a part already shown extends that element by the
/// whitespace that had been trimmed from its end plus the delta, trimmed.
fn thinking_delta(turn: &Value, pending: &[PendingRequest], message: &str, index: &str, delta: &str) -> Option<Out> {
    if delta.is_empty() {
        return None;
    }
    let item = format!("{message}:thinking");
    let parts = turn["_claudeThinking"][message].as_object()?;
    let raw = parts.get(index)?.as_str()?;
    let cut = raw.len().checked_sub(delta.len()).filter(|cut| raw.is_char_boundary(*cut))?;
    let (before, now) = (&raw[..cut], raw);
    if now.trim().is_empty() {
        return None;
    }
    // Same order as render_thinking: by numeric index, stably.
    let mut shown: Vec<(u64, &str)> = parts.iter()
        .filter(|(_, text)| text.as_str().is_some_and(|t| !t.trim().is_empty()))
        .map(|(key, _)| (key.parse().unwrap_or(u64::MAX), key.as_str()))
        .collect();
    shown.sort_by_key(|(number, _)| *number);
    let position = shown.iter().position(|(_, key)| *key == index)?;
    let whole = || find_item(turn, &item).map(|value| Out::Item(client_item(value, pending), None));
    if before.trim().is_empty() {
        // This part just became visible: a new last element, or the Item.
        return if shown.len() > 1 && position == shown.len() - 1 {
            Some(Out::Append { item, field: "summary", index: Some(position), text: now.trim().into() })
        } else {
            whole()
        };
    }
    let trailing = &before[before.trim_end().len()..];
    let text = format!("{trailing}{delta}");
    let text = text.trim_end();
    (!text.is_empty()).then(|| Out::Append { item, field: "summary", index: Some(position), text: text.into() })
}

/// The Items a Claude `assistant` or `user` event changes once
/// `project_event` has applied it. Mirrors `project_event`.
pub fn claude_items(event: &Value) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let mut add = |id: Option<String>| {
        if let Some(id) = id {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
    };
    let subagent = event["parent_tool_use_id"].is_string();
    match event["type"].as_str() {
        Some("assistant") => {
            let Some(message) = event["message"]["id"].as_str() else { return ids };
            for block in event["message"]["content"].as_array().into_iter().flatten() {
                match block["type"].as_str() {
                    Some("text") if !subagent => add(Some(message.into())),
                    Some("thinking") if !subagent => add(Some(format!("{message}:thinking"))),
                    Some("tool_use") => add(block["id"].as_str().map(str::to_owned)),
                    _ => {}
                }
            }
        }
        Some("user") => {
            for block in event["message"]["content"].as_array().into_iter().flatten() {
                if block["type"] == "tool_result" {
                    add(block["tool_use_id"].as_str().map(str::to_owned));
                }
            }
        }
        _ => {}
    }
    ids
}

impl Workspace {
    /// The Agent's listed entry, where reading it may wait: it can be built
    /// from a held record, under that record's lock. Never parses a record.
    /// None on an async worker (see `db::off_worker`), and for an Agent that
    /// is neither listed nor held.
    fn listed_off_worker(&self, id: &str) -> Option<crate::model::Agent> {
        crate::db::off_worker().then(|| self.store.listed_agent(id)).flatten()
    }

    /// perf-sse: one Agent changed in a way only a refetch shows. Called from
    /// async code too: there it sends the revision alone, read without
    /// waiting (`lastSeq` is for read receipts; clients refetch either way).
    pub(crate) fn announce_changed(&self, id: &str) {
        let (rev, last_seq) = match self.listed_off_worker(id) {
            Some(agent) => (Some(agent.rev), Some(agent.last_seq)),
            None if crate::db::off_worker() => (None, None),
            None => (Some(self.store.rev(id)).filter(|rev| *rev > 0), None),
        };
        self.changes.publish(&json!({"type":"agent.changed","agentId":id,"rev":rev,"lastSeq":last_seq}));
    }

    /// perf-sse: the stream ticker's per-Agent announcement. Its Items were
    /// already sent; clients update the Agent's listed entry from it. Off the
    /// async workers (the ticker's job); elsewhere it is a refetch notice.
    pub fn progressed(&self, id: &str) {
        match self.listed_off_worker(id) {
            Some(agent) => {
                self.changes.publish(&json!({"type":"agent.progress","agentId":id,
                    "rev":agent.rev,"lastSeq":agent.last_seq,"agent":agent}));
            }
            None => self.announce_changed(id),
        }
        self.collaboration_wakeup.notify_one();
    }

    /// perf-sse: the Codex catalog connection's state, shown with the
    /// Agent list; clients are told when it changes.
    pub async fn set_runtime(&self, value: Value) {
        let mut runtime = self.runtime.lock().await;
        if *runtime != value {
            *runtime = value;
            drop(runtime);
            self.changes.send(json!({"runtime":true}));
        }
    }

    fn publish_out(&self, id: &str, rev: u64, turn: &str, out: Out) {
        let message = match out {
            Out::Append { item, field, index, text } => {
                let mut message = json!({"type":"agent.delta","agentId":id,"rev":rev,"turnId":turn,"itemId":item,
                    "op":"append","field":field,"text":text});
                if let Some(index) = index {
                    message["index"] = index.into();
                }
                message
            }
            Out::Item(item, artifacts) => {
                let mut message = json!({"type":"agent.item","agentId":id,"rev":rev,"turnId":turn,"item":item});
                if let Some(artifacts) = artifacts {
                    message["artifacts"] = artifacts;
                }
                message
            }
            Out::Context(fields) => {
                let mut message = json!({"type":"agent.context","agentId":id,"rev":rev});
                for (key, value) in fields.as_object().into_iter().flatten() {
                    message[key] = value.clone();
                }
                message
            }
            Out::Changed => return self.announce_changed(id),
        };
        self.changes.publish(&message);
    }

    /// perf-sse: a Codex progress event was applied by `store.record_stream`
    /// as revision `rev`. Sends what it changed. The caller still holds the
    /// native event lock, so no other native event for this Agent has been
    /// applied since.
    pub(crate) fn streamed_codex(&self, id: &str, method: &str, p: &Value, rev: u64) {
        let turn = p["turnId"].as_str().or_else(|| p["turn"]["id"].as_str());
        if method == "thread/tokenUsage/updated" {
            // Measured with or without a Turn.
            return match self.store.peek(id, |d| d.context_usage.clone()) {
                Some(usage) => self.publish_out(id, rev, turn.unwrap_or_default(),
                    Out::Context(json!({"contextUsage":usage}))),
                None => self.announce_changed(id),
            };
        }
        // Everything else Core applies needs a Turn.
        let Some(turn) = turn else { return };
        let delta = |field: &'static str, index: Option<usize>, text: &str| Out::Append {
            item: p["itemId"].as_str().unwrap_or_default().into(), field, index, text: text.into(),
        };
        let out = match method {
            "item/agentMessage/delta" | "item/plan/delta" if p["itemId"].is_string() => {
                delta("text", None, p["delta"].as_str().unwrap_or_default())
            }
            "item/commandExecution/outputDelta" if p["itemId"].is_string() => {
                delta("aggregatedOutput", None, p["delta"].as_str().unwrap_or_default())
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/summaryPartAdded" if p["itemId"].is_string() => {
                let Some(index) = p["summaryIndex"].as_u64() else { return };
                let text = if method.ends_with("Delta") { p["delta"].as_str().unwrap_or_default() } else { "" };
                delta("summary", Some(index as usize), text)
            }
            "item/started" | "item/completed" => {
                let Some(item_id) = p["item"]["id"].as_str() else { return };
                let kind = p["item"]["type"].as_str().unwrap_or_default();
                let read = self.store.peek(id, |d| {
                    let item = d.turns.iter().find(|t| t["id"] == turn).and_then(|t| find_item(t, item_id))
                        .map(|item| client_item(item, &d.pending));
                    let artifacts = (kind == "fileChange").then(|| serde_json::to_value(&d.artifacts).ok()).flatten();
                    item.map(|item| Out::Item(item, artifacts))
                });
                let Some(out) = read.flatten() else { return self.announce_changed(id) };
                self.publish_out(id, rev, turn, out);
                // Turn compaction marks and message receipts are not in the Item.
                if matches!(kind, "contextCompaction" | "userMessage") {
                    self.announce_changed(id);
                }
                return;
            }
            // The Turn's plan is rare; a refetch shows it.
            "turn/plan/updated" => Out::Changed,
            _ => return,
        };
        self.publish_out(id, rev, turn, out);
    }

    /// perf-sse: a Claude progress event was applied by `store.record_stream`
    /// as revision `rev`; sends what `claude_changes` finds. The caller still
    /// holds the native event lock. Nothing is remembered between events.
    pub(crate) fn streamed_claude(&self, id: &str, turn: Option<&str>, event: &Value, rev: u64) {
        // A sub-agent's event changed the Turn of the call that started it.
        let Some((turn, outs)) = self.store.peek(id, |d| {
            let turn = crate::claude::event_turn(d, turn, event);
            let outs = claude_changes(d, turn.as_deref(), event);
            (turn, outs)
        }) else {
            return self.announce_changed(id);
        };
        for out in outs {
            self.publish_out(id, rev, turn.as_deref().unwrap_or_default(), out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(entries: &[Arc<Entry>]) -> Vec<u64> {
        entries.iter().map(|e| e.n).collect()
    }

    #[test]
    fn a_reconnect_in_the_ring_replays_everything_after_its_id_once() {
        let events = Events::new();
        for n in 0..5 {
            events.publish(&json!({"n":n}));
        }
        let mut live = events.subscribe(Some(&events.id(2)));
        let Start::Resumed { from, replay } = &live.start else { panic!("{:?}", live.start) };
        assert_eq!(from, &events.id(2));
        assert_eq!(ids(replay), vec![3, 4, 5]);
        assert_eq!(replay[0].data, json!({"n":2}).to_string());
        // Caught up: nothing to replay, but nothing to refetch either.
        let mut current = events.subscribe(Some(&events.id(5)));
        assert_eq!(current.start, Start::Resumed { from: events.id(5), replay: vec![] });
        // Later messages reach both through their queues, once.
        events.publish(&json!({"n":5}));
        for s in [&mut live, &mut current] {
            assert_eq!(s.try_next().unwrap().n, 6);
            assert!(s.try_next().is_none());
        }
    }

    #[test]
    fn unknown_old_or_foreign_ids_reset() {
        let events = Events::new();
        for n in 0..(RING_EVENTS + 10) {
            events.publish(&json!({"n":n}));
        }
        let head = events.head();
        assert_eq!(head, RING_EVENTS as u64 + 10);
        let reset = |id: Option<&str>| match events.subscribe(id).start {
            Start::Reset { head: h, reason } => { assert_eq!(h, head); reason }
            other => panic!("{other:?}"),
        };
        assert_eq!(reset(None), "new");
        // The oldest messages left the ring: ids before it cannot resume.
        assert_eq!(reset(Some(&events.id(5))), "expired");
        assert!(matches!(events.subscribe(Some(&events.id(10))).start, Start::Resumed { .. }));
        assert_eq!(reset(Some(&events.id(head + 1))), "unknown");
        assert_eq!(reset(Some(&format!("other-{head}"))), "epoch");
        assert_eq!(reset(Some("garbage")), "epoch");
    }

    #[test]
    fn the_ring_is_bounded_by_bytes_but_keeps_the_newest() {
        let events = Events::new();
        let big = "x".repeat(RING_BYTES / 2 + 1);
        events.publish(&json!({"a":big}));
        events.publish(&json!({"b":big}));
        events.publish(&json!({"c":big}));
        let hub = events.hub.lock().unwrap();
        assert_eq!(hub.ring.len(), 1);
        assert_eq!(hub.ring[0].n, 3);
    }

    #[test]
    fn the_ring_and_a_queue_hold_each_message_at_the_length_they_count() {
        let events = Events::new();
        let mut live = events.subscribe(None);
        // Encoding grows the string as it writes, doubling it when it is full.
        for len in [1, 300, 5_000, 70_000] {
            events.publish(&json!({"text":"z".repeat(len)}));
        }
        let Start::Resumed { replay, .. } = events.subscribe(Some(&events.id(0))).start else { panic!() };
        let queued: Vec<_> = std::iter::from_fn(|| live.try_next()).collect();
        for entries in [&replay, &queued] {
            assert_eq!(ids(entries), vec![1, 2, 3, 4]);
            for e in entries {
                assert_eq!(e.data.capacity(), e.data.len(), "#{}", e.n);
            }
        }
    }

    #[test]
    fn a_client_that_falls_behind_is_dropped_without_blocking_others() {
        let events = Events::new();
        let mut slow = events.subscribe(None);
        let mut fast = events.subscribe(None);
        for n in 0..SUBSCRIBER_QUEUE {
            events.publish(&json!({"n":n}));
            assert_eq!(fast.try_next().unwrap().n, n as u64 + 1);
        }
        assert!(!slow.overflowed());
        // One more than its queue holds: publishing does not wait for it.
        events.publish(&json!({"n":"over"}));
        assert!(slow.overflowed());
        assert_eq!(fast.try_next().unwrap().n, SUBSCRIBER_QUEUE as u64 + 1);
        assert_eq!(events.subscribers(), 1);
        // Its queue ends; nothing after the overflow reaches it.
        let mut got = 0;
        while slow.try_next().is_some() { got += 1; }
        assert_eq!(got, SUBSCRIBER_QUEUE);
        assert!(matches!(slow.rx.try_recv(), Err(mpsc::error::TryRecvError::Disconnected)));
    }

    #[test]
    fn a_queue_is_bounded_by_bytes_too_even_for_messages_the_ring_dropped() {
        let events = Events::new();
        let slow = events.subscribe(None);
        let mut fast = events.subscribe(None);
        let big = "y".repeat(SUBSCRIBER_BYTES / 4);
        for n in 0..3 {
            events.publish(&json!({"n":n,"big":big}));
            assert!(fast.try_next().is_some());
        }
        assert!(!slow.overflowed());
        // A fourth would put more than SUBSCRIBER_BYTES in the slow queue.
        events.publish(&json!({"n":3,"big":big}));
        assert!(slow.overflowed(), "reset instead of holding another large message");
        assert!(!fast.overflowed(), "a client that keeps up is unaffected");
        assert!(fast.try_next().is_some());
        // Reading frees the budget: a drained client never overflows.
        for _ in 0..8 {
            events.publish(&json!({"big":big}));
            assert!(fast.try_next().is_some());
        }
        assert!(!fast.overflowed());
        assert_eq!(fast.queue.bytes.load(Ordering::Acquire), 0);
    }

    #[test]
    fn old_notices_keep_their_fields_and_gain_a_type() {
        let events = Events::new();
        let mut s = events.subscribe(None);
        events.send(json!({"collaboration":true}));
        events.send(json!({"agentId":"a"}));
        events.send(json!({"machines":true}));
        events.send(json!({"runtime":true}));
        let mut next = || serde_json::from_str::<Value>(&s.try_next().unwrap().data).unwrap();
        assert_eq!(next(), json!({"collaboration":true,"type":"workspace.changed","scope":"collaboration"}));
        assert_eq!(next(), json!({"agentId":"a","type":"agent.changed"}));
        assert_eq!(next(), json!({"machines":true,"type":"workspace.changed","scope":"machines"}));
        assert_eq!(next(), json!({"runtime":true,"type":"workspace.changed","scope":"runtime"}));
    }

    fn claude_detail() -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":"c","name":"C","cwd":"/tmp","model":"m","color":"sage","harness":"claude",
            "claudeSessionId":"s","threadId":null,"status":"working","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},
            "turns":[{"id":"t","status":"inProgress","items":[]}],"pending":[],"artifacts":[]})).unwrap()
    }

    /// The client's copy of a Turn's Items after one event's messages, as
    /// web/src/detail-patch.ts applies them. None: it would refetch.
    fn client_apply(items: &mut Vec<Value>, outs: &[Out]) -> Option<()> {
        for out in outs {
            match out {
                Out::Item(item, _) => match items.iter_mut().find(|i| i["id"] == item["id"]) {
                    Some(old) => *old = item.clone(),
                    None => items.push(item.clone()),
                },
                Out::Append { item, field, index, text } => {
                    let target = items.iter_mut().find(|i| i["id"] == item.as_str())?;
                    match index {
                        None => {
                            let value = format!("{}{text}", target[*field].as_str().unwrap_or(""));
                            target[*field] = value.into();
                        }
                        Some(index) => {
                            if !target[*field].is_array() { target[*field] = json!([]); }
                            let parts = target[*field].as_array_mut()?;
                            while parts.len() <= *index { parts.push("".into()); }
                            parts[*index] = format!("{}{text}", parts[*index].as_str()?).into();
                        }
                    }
                }
                Out::Context(_) => {}
                Out::Changed => return None,
            }
        }
        Some(())
    }

    /// Every message a stream of Claude events produces, applied by a client
    /// that started from the record at any point (a read), reproduces the
    /// record's Items after every event.
    #[test]
    fn claude_messages_reproduce_the_projected_items_after_every_event() {
        let se = |e: Value| json!({"type":"stream_event","session_id":"s","event":e});
        let start = |i: u64, block: Value| se(json!({"type":"content_block_start","index":i,"content_block":block}));
        let text = |i: u64, t: &str| se(json!({"type":"content_block_delta","index":i,"delta":{"type":"text_delta","text":t}}));
        let think = |i: u64, t: &str| se(json!({"type":"content_block_delta","index":i,"delta":{"type":"thinking_delta","thinking":t}}));
        let json_delta = |i: u64, t: &str| se(json!({"type":"content_block_delta","index":i,"delta":{"type":"input_json_delta","partial_json":t}}));
        let mut events = vec![
            se(json!({"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}})),
            start(0, json!({"type":"thinking","thinking":""})),
        ];
        // Thinking whose deltas start and end with whitespace, trimmed per part.
        for t in ["  ", "Let me ", "  think", " ", "\n", "about it.  ", "\n\n"] { events.push(think(0, t)); }
        events.push(start(1, json!({"type":"text","text":""})));
        for t in ["Hel", "lo ", "wörld", " ", "", "— ok."] { events.push(text(1, t)); }
        events.push(start(2, json!({"type":"thinking","thinking":""})));
        for t in [" ", "Second", " part "] { events.push(think(2, t)); }
        events.push(start(3, json!({"type":"text","text":"More"})));
        for t in [" text", "."] { events.push(text(3, t)); }
        events.push(start(4, json!({"type":"tool_use","id":"tool","name":"Write","input":{}})));
        for t in ["{\"file_path\":", " \"/w/a", ".md\", \"x\": {\"y\": 1}", "}"] { events.push(json_delta(4, t)); }
        events.push(se(json!({"type":"message_delta","usage":{"output_tokens":4}})));
        events.push(json!({"type":"assistant","session_id":"s","uuid":"u1","message":{"id":"m1","content":[
            {"type":"thinking","thinking":"Let me   think \nabout it."},{"type":"text","text":"Hello wörld — ok."},
            {"type":"text","text":"More text."},{"type":"tool_use","id":"tool","name":"Write","input":{"file_path":"/w/a.md"}}]}}));
        events.push(json!({"type":"user","session_id":"s","message":{"content":[{"type":"tool_result","tool_use_id":"tool","content":"ok","is_error":false}]}}));
        // A client may have read the record before any event.
        for read_at in 0..events.len() {
            let mut d = claude_detail();
            let mut client: Option<Vec<Value>> = None;
            for (n, event) in events.iter().enumerate() {
                crate::claude::project_event(&mut d, Some("t"), event);
                let outs = claude_changes(&d, Some("t"), event);
                for out in &outs {
                    if let Out::Append { text, .. } = out { assert!(!text.is_empty(), "event {n}: empty append"); }
                }
                if n < read_at { continue; }
                if n == read_at {
                    client = Some(d.turns[0]["items"].as_array().unwrap().clone());
                    continue;
                }
                let items = client.as_mut().unwrap();
                client_apply(items, &outs).unwrap_or_else(|| panic!("event {n} would refetch: {outs:?}"));
                assert_eq!(items, d.turns[0]["items"].as_array().unwrap(), "after event {n} {event}, read at {read_at}");
            }
        }
        // Each delta costs a delta: appends, not whole Items.
        let mut d = claude_detail();
        let mut kinds = vec![];
        for event in &events {
            crate::claude::project_event(&mut d, Some("t"), event);
            kinds.extend(claude_changes(&d, Some("t"), event).into_iter().map(|o| match o {
                Out::Append { .. } => 'a', Out::Item(..) => 'I', Out::Context(_) => 'c', Out::Changed => '!',
            }));
        }
        let kinds: String = kinds.into_iter().collect();
        // Ten text and thinking deltas with visible text are appends. Items go
        // out at block starts, a message's first text, a thinking part that
        // appears, closing tool JSON, confirmation and tool results.
        assert_eq!(kinds, "IaaIIaaaaIaaIaaIIIcIIII");
    }

    /// A client's Items after applying stream messages (JSON) in order.
    fn apply_messages(items: &mut Vec<Value>, messages: &[Value]) {
        for m in messages {
            match m["type"].as_str() {
                Some("agent.item") => match items.iter_mut().find(|i| i["id"] == m["item"]["id"]) {
                    Some(old) => *old = m["item"].clone(),
                    None => items.push(m["item"].clone()),
                },
                Some("agent.delta") => {
                    let item = items.iter_mut().find(|i| i["id"] == m["itemId"]).expect("known Item");
                    let field = m["field"].as_str().unwrap();
                    let text = m["text"].as_str().unwrap();
                    match m["index"].as_u64() {
                        None => item[field] = format!("{}{text}", item[field].as_str().unwrap_or("")).into(),
                        Some(index) => {
                            if !item[field].is_array() { item[field] = json!([]); }
                            let parts = item[field].as_array_mut().unwrap();
                            while parts.len() <= index as usize { parts.push("".into()); }
                            let part = &mut parts[index as usize];
                            *part = format!("{}{text}", part.as_str().unwrap()).into();
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// A read taken at any point, plus the messages with a higher revision,
    /// is exactly the record: nothing is missing and nothing applied twice,
    /// across non-streamed changes and read marks in between.
    #[test]
    fn a_read_at_any_point_plus_later_messages_is_the_record() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m",
            "color":"sage","threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[{"id":"t","status":"inProgress","items":[]}],
            "pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
        let mut live = ws.changes.subscribe(None);
        // As on_event does: what the store applied, then what it changed.
        let streamed = |method: &str, p: Value| {
            let route = crate::store::route(method, &p);
            let done = ws.store.record_stream("a", route, method, &p).unwrap();
            if let Some(rev) = done.rev {
                ws.streamed_codex("a", method, &p, rev);
            }
        };
        let mut reads = vec![ws.store.detail("a").unwrap()];
        streamed("item/started", json!({"turnId":"t","item":{"id":"m","type":"agentMessage","text":""}}));
        streamed("item/started", json!({"turnId":"t","item":{"id":"r","type":"reasoning","summary":[],"content":[]}}));
        for n in 0..12 {
            streamed("item/agentMessage/delta", json!({"turnId":"t","itemId":"m","delta":format!("w{n} ")}));
            if n % 3 == 0 {
                streamed("item/reasoning/summaryPartAdded", json!({"turnId":"t","itemId":"r","summaryIndex":n / 3}));
            }
            streamed("item/reasoning/summaryTextDelta", json!({"turnId":"t","itemId":"r","summaryIndex":n / 3,"delta":"x"}));
            reads.push(ws.store.detail("a").unwrap());
            if n == 4 {
                // A change that is not streamed: the held copy is written and dropped.
                ws.store.update("a", "test/note", &json!({}), |d| d.agent.error = Some("note".into())).unwrap();
                reads.push(ws.store.detail("a").unwrap());
            }
            if n == 7 {
                ws.store.review("a", 1).unwrap();
                reads.push(ws.store.detail("a").unwrap());
            }
        }
        // Token usage measured outside a Turn still reaches the meter.
        streamed("thread/tokenUsage/updated", json!({"tokenUsage":{"last":{"totalTokens":300},"modelContextWindow":1000}}));
        let mut messages = vec![];
        while let Some(entry) = live.try_next() {
            messages.push(serde_json::from_str::<Value>(&entry.data).unwrap());
        }
        let last = ws.store.detail("a").unwrap();
        let expected = last.turns[0]["items"].as_array().unwrap();
        assert_eq!(expected[0]["text"], (0..12).map(|n| format!("w{n} ")).collect::<String>());
        let usage = messages.iter().rev().find(|m| m["type"] == "agent.context").expect("a context message");
        assert_eq!(usage["contextUsage"]["usedTokens"], 300);
        assert_eq!(usage["rev"].as_u64(), Some(last.agent.rev));
        let mut revisions: Vec<u64> = reads.iter().map(|r| r.agent.rev).collect();
        revisions.dedup();
        assert!(revisions.windows(2).all(|w| w[0] < w[1]), "every read is a later revision: {revisions:?}");
        for read in &reads {
            let after: Vec<Value> = messages.iter()
                .filter(|m| m["rev"].as_u64().is_some_and(|rev| rev > read.agent.rev)).cloned().collect();
            let mut items = read.turns[0]["items"].as_array().unwrap().clone();
            apply_messages(&mut items, &after);
            assert_eq!(&items, expected, "read at revision {}", read.agent.rev);
        }
    }

    /// Items go out as the detail API projects them: a large command output
    /// as a bounded tail preview, unless a pending request refers to it.
    #[test]
    fn pushed_items_are_projected_like_the_detail() {
        use crate::client_view::{PREVIEW, TRUNCATED};
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m",
            "color":"sage","threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[{"id":"t","status":"inProgress","items":[]}],
            "pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
        let mut live = ws.changes.subscribe(None);
        let output: String = (0..20_000).map(|n| format!("line {n}\n")).collect();
        let item = json!({"id":"c","type":"commandExecution","command":"make","status":"completed","aggregatedOutput":output});
        let p = json!({"turnId":"t","item":item});
        let done = ws.store.record_stream("a", crate::store::route("item/completed", &p), "item/completed", &p).unwrap();
        ws.streamed_codex("a", "item/completed", &p, done.rev.unwrap());
        let sent: Value = serde_json::from_str(&live.try_next().unwrap().data).unwrap();
        let shown = sent["item"]["aggregatedOutput"].as_str().unwrap();
        assert!(shown.len() <= PREVIEW && output.ends_with(shown), "a tail preview, never the whole output");
        assert_eq!(sent["item"][TRUNCATED]["aggregatedOutput"]["bytes"], output.len());
        assert_eq!(sent["item"][TRUNCATED]["aggregatedOutput"]["keep"], "tail");
        // The detail API sends the same.
        let read = crate::client_view::detail(ws.store.detail("a").unwrap());
        assert_eq!(read.turns[0]["items"][0], sent["item"]);
    }

    #[tokio::test]
    async fn the_codex_catalog_state_is_announced_when_it_changes() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
        let mut live = ws.changes.subscribe(None);
        ws.set_runtime(json!({"connected":true,"account":"x"})).await;
        ws.set_runtime(json!({"connected":true,"account":"x"})).await;
        ws.set_runtime(json!({"connected":false})).await;
        let mut scopes = vec![];
        while let Some(entry) = live.try_next() {
            scopes.push(serde_json::from_str::<Value>(&entry.data).unwrap()["scope"].clone());
        }
        assert_eq!(scopes, vec![json!("runtime"), json!("runtime")], "once per change");
        assert_eq!(*ws.runtime.lock().await, json!({"connected":false}));
    }

    #[test]
    fn a_session_mismatch_is_a_change_even_without_a_turn() {
        let mut d = claude_detail();
        let event = json!({"type":"stream_event","session_id":"other","event":{"type":"message_start","message":{"id":"x"}}});
        crate::claude::project_event(&mut d, None, &event);
        assert_eq!(d.agent.status, "uncertain");
        assert_eq!(claude_changes(&d, None, &event), vec![Out::Changed]);
        // Its own session and no Turn: nothing changed.
        let mut d = claude_detail();
        let own = json!({"type":"stream_event","session_id":"s","event":{"type":"message_start","message":{"id":"x"}}});
        crate::claude::project_event(&mut d, None, &own);
        assert!(claude_changes(&d, None, &own).is_empty());
    }

    /// The messages a Claude sub-agent's events produce reproduce the
    /// record's Items: its call as task events change it, its own calls, and
    /// those its end settled.
    #[test]
    fn subagent_messages_reproduce_the_projected_items_after_every_event() {
        let call = |id: &str, name: &str, parent: Option<&str>| json!({"type":"assistant","session_id":"s","uuid":format!("u-{id}"),
            "parent_tool_use_id":parent,"message":{"id":format!("m-{id}"),"content":[{"type":"tool_use","id":id,"name":name,"input":{"description":"Read b.txt"}}]}});
        let task = |subtype: &str, extra: Value| {
            let mut event = json!({"type":"system","subtype":subtype,"session_id":"s","task_id":"task"});
            event.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            event
        };
        let events = [
            call("agent", "Agent", None),
            task("task_started", json!({"tool_use_id":"agent","task_type":"local_agent","description":"Read b.txt","prompt":"Do it"})),
            call("read", "Read", Some("agent")),
            json!({"type":"user","session_id":"s","parent_tool_use_id":"agent","message":{"content":[{"type":"tool_result","tool_use_id":"read","content":"bravo"}]}}),
            task("task_progress", json!({"tool_use_id":"agent","last_tool_name":"Read","usage":{"total_tokens":5,"tool_uses":1,"duration_ms":9}})),
            call("bash", "Bash", Some("agent")),
            task("task_updated", json!({"patch":{"status":"killed"}})),
            task("task_notification", json!({"tool_use_id":"agent","status":"stopped","summary":"Stopped."})),
            json!({"type":"user","session_id":"s","message":{"content":[{"type":"tool_result","tool_use_id":"agent","content":"Stopped.","is_error":true}]},
                "tool_use_result":"Stopped."}),
        ];
        for read_at in 0..events.len() {
            let mut d = claude_detail();
            let mut client: Option<Vec<Value>> = None;
            for (n, event) in events.iter().enumerate() {
                crate::claude::project_event(&mut d, Some("t"), event);
                let outs = claude_changes(&d, Some("t"), event);
                if n < read_at { continue; }
                if n == read_at {
                    client = Some(d.turns[0]["items"].as_array().unwrap().clone());
                    continue;
                }
                let items = client.as_mut().unwrap();
                client_apply(items, &outs).unwrap_or_else(|| panic!("event {n} would refetch: {outs:?}"));
                assert_eq!(items, d.turns[0]["items"].as_array().unwrap(), "after event {n} {event}, read at {read_at}");
            }
        }
    }

    /// A background sub-agent reporting after its Turn ended, in no Turn or
    /// inside another one, is announced in the Turn of its call.
    #[test]
    fn a_late_subagent_event_is_announced_in_the_turn_of_its_call() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
        let mut detail = claude_detail();
        detail.turns = vec![
            json!({"id":"t","status":"completed","items":[{"id":"agent","type":"claudeToolUse","name":"Agent","status":"completed",
                "subAgent":{"taskId":"task","status":"running","background":true}}]}),
            json!({"id":"t2","status":"inProgress","items":[]}),
        ];
        ws.store.insert(&detail).unwrap();
        let mut live = ws.changes.subscribe(None);
        let late = [
            (None, json!({"type":"system","subtype":"task_notification","session_id":"s","task_id":"task","tool_use_id":"agent","status":"completed","summary":"charlie"})),
            (Some("t2"), json!({"type":"assistant","session_id":"s","uuid":"s-1","parent_tool_use_id":"agent","message":{"id":"m-s","content":[
                {"type":"tool_use","id":"c-read","name":"Read","input":{}}]}})),
        ];
        for (turn, event) in late {
            let message = json!({"type":"event","turnId":turn,"event":event});
            let kind = format!("claude/{}", event["type"].as_str().unwrap());
            let done = ws.store.record_stream("c", crate::store::route(&kind, &message), &kind, &message).unwrap();
            ws.streamed_claude("c", turn, &event, done.rev.unwrap());
        }
        let sent: Vec<Value> = std::iter::from_fn(|| live.try_next())
            .map(|entry| serde_json::from_str::<Value>(&entry.data).unwrap())
            .filter(|message| message["type"] == "agent.item")
            .collect();
        let shown: Vec<_> = sent.iter().map(|m| (m["turnId"].clone(), m["item"]["id"].clone())).collect();
        assert_eq!(shown, vec![(json!("t"), json!("agent")), (json!("t"), json!("c-read"))]);
        assert_eq!(sent[0]["item"]["subAgent"]["status"], "completed");
        assert_eq!(sent[1]["item"]["parentToolUseId"], "agent");
    }

    /// A background shell's end after its Turn ended is announced as its
    /// call, in the Turn of that call.
    #[test]
    fn a_late_background_task_event_is_announced_in_the_turn_of_its_call() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
        let mut detail = claude_detail();
        detail.turns = vec![json!({"id":"t","status":"completed","items":[{"id":"bash","type":"claudeToolUse","name":"Bash","status":"completed",
            "input":{"command":"sleep 25","run_in_background":true},"backgroundTask":{"taskId":"b1","type":"local_bash","status":"running","background":true}}]})];
        ws.store.insert(&detail).unwrap();
        let mut live = ws.changes.subscribe(None);
        let event = json!({"type":"system","subtype":"task_notification","session_id":"s","task_id":"b1","tool_use_id":"bash",
            "status":"completed","output_file":"/tmp/b1.output","summary":"Background command completed (exit code 0)"});
        let message = json!({"type":"event","turnId":null,"event":event});
        let done = ws.store.record_stream("c", crate::store::route("claude/system", &message), "claude/system", &message).unwrap();
        ws.streamed_claude("c", None, &event, done.rev.unwrap());
        let sent: Vec<Value> = std::iter::from_fn(|| live.try_next())
            .map(|entry| serde_json::from_str::<Value>(&entry.data).unwrap())
            .filter(|message| message["type"] == "agent.item")
            .collect();
        assert_eq!(sent.len(), 1);
        assert_eq!((sent[0]["turnId"].clone(), sent[0]["item"]["id"].clone(), sent[0]["item"]["backgroundTask"]["status"].clone()),
            (json!("t"), json!("bash"), json!("completed")));
    }

    /// On an async worker, telling clients an Agent changed never waits for
    /// a held record's lock (nor builds its listed entry from it), even when
    /// a reader holds the record and an event waits to change it.
    #[tokio::test]
    async fn announcing_from_async_code_never_waits_for_a_held_record() {
        use std::time::{Duration, Instant};
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused".into()).unwrap();
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":"a","name":"A","cwd":"/tmp","model":"m",
            "color":"sage","threadId":"thread","status":"working","createdAt":"","updatedAt":"","unreadCount":0,
            "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[{"id":"t","status":"inProgress","items":[]}],
            "pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
        let delta = |text: &str| {
            let p = json!({"turnId":"t","itemId":"reply","delta":text});
            (crate::store::route("item/agentMessage/delta", &p), p)
        };
        // Held, and its listed entry stale.
        let (route, p) = delta("held ");
        ws.store.record_stream("a", route, "item/agentMessage/delta", &p).unwrap();
        // A reader holds the record; an event then waits to change it.
        let (reading, read) = std::sync::mpsc::channel();
        let reader = std::thread::spawn({
            let store = ws.store.clone();
            move || store.peek("a", |_| { reading.send(()).unwrap(); std::thread::sleep(Duration::from_millis(600)); })
        });
        read.recv().unwrap();
        let writer = std::thread::spawn({
            let store = ws.store.clone();
            move || {
                let (route, p) = delta("waiting");
                store.record_stream("a", route, "item/agentMessage/delta", &p).unwrap();
            }
        });
        std::thread::sleep(Duration::from_millis(50));
        let mut live = ws.changes.subscribe(None);
        let started = Instant::now();
        ws.announce_changed("a");
        ws.progressed("a");
        let took = started.elapsed();
        assert!(took < Duration::from_millis(300), "waited {took:?}");
        let mut sent = vec![];
        while let Some(entry) = live.try_next() {
            sent.push(serde_json::from_str::<Value>(&entry.data).unwrap());
        }
        assert_eq!(sent.len(), 2);
        assert!(sent.iter().all(|m| m["type"] == "agent.changed" && m["rev"].is_u64() && m["lastSeq"].is_null()), "{sent:#?}");
        reader.join().unwrap();
        writer.join().unwrap();
        // Off the workers the listed entry is sent, built from the record.
        let off = ws.clone();
        crate::db::blocking(move || { off.progressed("a"); Ok(()) }).await.unwrap();
        let progress = serde_json::from_str::<Value>(&live.try_next().unwrap().data).unwrap();
        assert_eq!((progress["type"].as_str(), progress["agent"]["id"].as_str()), (Some("agent.progress"), Some("a")));
        assert_eq!(progress["rev"], ws.store.rev("a"));
    }
}
