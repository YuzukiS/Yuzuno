//! Background shells a Harness reports as still running, and the Claude
//! tasks its latest snapshot lists (what a single-task stop checks).
//!
//! Counts live only in memory and belong to the runtime connection
//! generation that reported them. A newer or missing connection makes the
//! count unknown, and unknown is never reported as zero. Shells are never
//! inferred from tool items, old inProgress records or Core's own processes.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use serde_json::{json, Value};

use crate::conversation_time::now_ms;
use crate::rpc::Rpc;
use crate::workspace::Workspace;

/// Codex reports a background terminal's exit as its commandExecution
/// `item/completed`. The list is read once more shortly after, in case that
/// notice arrives before the terminal has left the list.
const SETTLE: Duration = Duration::from_secs(3);
const PAGE_SIZE: u64 = 100;
const MAX_PAGES: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Harness {
    Codex,
    Claude,
}

#[derive(Clone, Debug)]
struct Entry {
    harness: Harness,
    generation: u64,
    /// None when the last check for this generation failed.
    count: Option<usize>,
    /// Last count that was known, kept to explain a later unknown.
    last_count: usize,
    checked_at: i64,
    ticket: u64,
}

#[derive(Default)]
pub struct Registry {
    entries: Mutex<HashMap<String, Entry>>,
    tickets: std::sync::atomic::AtomicU64,
    /// Claude's latest snapshot, per Agent: the connection generation that
    /// sent it, the ids of every task it lists (ambient ones included), how
    /// many of them are not ambient (real background work), and how many of
    /// those are sub-agents (`local_agent`, YN-51).
    claude_live: Mutex<HashMap<String, (u64, HashSet<String>, usize, usize)>>,
}

impl Registry {
    fn ticket(&self) -> u64 {
        self.tickets.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }

    /// Stores a result unless a check that started later already did.
    /// Returns whether what a reader sees changed.
    fn record(&self, id: &str, harness: Harness, generation: u64, ticket: u64, count: Option<usize>) -> bool {
        let mut entries = self.entries.lock().unwrap();
        let previous = entries.get(id).cloned();
        if previous.as_ref().is_some_and(|e| e.ticket > ticket) {
            return false;
        }
        let last_count = count.or(previous.as_ref().map(|e| e.last_count)).unwrap_or(0);
        entries.insert(id.into(), Entry {
            harness,
            generation,
            count,
            last_count,
            checked_at: now_ms(),
            ticket,
        });
        previous.is_none_or(|e| e.generation != generation || e.count != count)
    }

    /// Applies a Claude `background_tasks_changed` snapshot. Each snapshot
    /// replaces the whole set; ambient tasks are not activity. Returns
    /// whether what a reader sees changed: its shells, or its sub-agents.
    pub fn record_claude(&self, id: &str, generation: u64, event: &Value) -> bool {
        let Some(tasks) = event["tasks"].as_array() else { return false };
        let live = tasks.iter().filter_map(|task| task["task_id"].as_str().map(str::to_owned)).collect();
        let active = tasks.iter().filter(|task| task["ambient"] != true).count();
        let of = |kind: &str| tasks.iter().filter(|task| task["task_type"] == kind && task["ambient"] != true).count();
        let agents = of("local_agent");
        let before = self.claude_live.lock().unwrap().insert(id.into(), (generation, live, active, agents));
        let agents_changed = before.is_none_or(|(seen, _, _, was)| seen != generation || was != agents);
        let shells_changed = self.record(id, Harness::Claude, generation, self.ticket(), Some(of("local_bash")));
        shells_changed || agents_changed
    }

    fn entry(&self, id: &str) -> Option<Entry> {
        self.entries.lock().unwrap().get(id).cloned()
    }

    /// Whether Claude's latest snapshot from this connection generation lists
    /// the task as running; None when that generation has sent none. Only
    /// this says a task is running now: Claude acknowledges a stop of any
    /// id, ended or unknown (CLI 2.1.280, T-25 probe).
    pub fn claude_running(&self, id: &str, generation: u64, task: &str) -> Option<bool> {
        let live = self.claude_live.lock().unwrap();
        let (_, tasks, _, _) = live.get(id).filter(|(seen, ..)| *seen == generation)?;
        Some(tasks.contains(task))
    }

    /// How many tasks other than ambient ones Claude's latest snapshot from
    /// this connection generation lists; None when it has sent none, which a
    /// bridge does until a task starts (Disconnect, T-184).
    pub fn claude_active(&self, id: &str, generation: u64) -> Option<usize> {
        let live = self.claude_live.lock().unwrap();
        live.get(id).filter(|(seen, ..)| *seen == generation).map(|(_, _, active, _)| *active)
    }

    /// Each Agent's background shells and Claude sub-agents its live
    /// connection reported last (`live`): `claude` and `codex` say which
    /// connection generation of an Agent is live now. A count that is
    /// unknown, or from an older connection, is left out.
    fn live_with(&self, claude: impl Fn(&str) -> Option<u64>, codex: impl Fn(&str) -> Option<u64>) -> BTreeMap<String, (usize, usize)> {
        // Copied out first: the generations are read under other locks.
        let entries: Vec<(String, Entry)> = self.entries.lock().unwrap().iter().map(|(id, e)| (id.clone(), e.clone())).collect();
        let agents: Vec<(String, u64, usize)> =
            self.claude_live.lock().unwrap().iter().map(|(id, (seen, _, _, agents))| (id.clone(), *seen, *agents)).collect();
        let mut live = BTreeMap::new();
        for (id, entry) in entries {
            let now = match entry.harness {
                Harness::Codex => codex(&id),
                Harness::Claude => claude(&id),
            };
            if let Some(count) = entry.count.filter(|_| now == Some(entry.generation)) {
                live.entry(id).or_insert((0, 0)).0 = count;
            }
        }
        for (id, seen, count) in agents {
            if claude(&id) == Some(seen) {
                live.entry(id).or_insert((0, 0)).1 = count;
            }
        }
        live
    }
}

/// Each Agent's background work its harness reports now (YN-51), for the
/// rail's ring: its shells (Claude, Codex) and Claude's sub-agents, as its
/// live connection last reported them; unknown is left out, never said as
/// none or as some. Lookups only: no lock is held while another is taken.
pub fn live(ws: &Workspace) -> BTreeMap<String, (usize, usize)> {
    ws.background_shells.live_with(
        |id| ws.claudes.lock().unwrap().get(id).map(|c| c.generation),
        |id| ws.codex_connection(id).map(|(generation, _)| generation),
    )
}

/// The Agent's background shell state for its detail response, or None when
/// no Harness has reported one. Lookups only: no lock is held while another
/// is taken.
pub fn shells(ws: &Workspace, id: &str) -> Option<Value> {
    let entry = ws.background_shells.entry(id)?;
    let live = match entry.harness {
        Harness::Codex => ws.codex_connection(id).map(|(generation, _)| generation),
        Harness::Claude => ws.claudes.lock().unwrap().get(id).map(|c| c.generation),
    };
    match entry.count {
        Some(count) if live == Some(entry.generation) => {
            Some(json!({"state":"known","count":count,"checkedAt":entry.checked_at}))
        }
        _ if entry.last_count > 0 => {
            Some(json!({"state":"unknown","lastCount":entry.last_count,"checkedAt":entry.checked_at}))
        }
        _ => None,
    }
}

/// Every recorded Codex event of an Agent, after it was recorded (whatever
/// its route). Only a Turn's end, or a command ending outside a running
/// Turn, can change its background terminals; those list them.
pub fn codex_event(ws: &Arc<Workspace>, id: &str, method: &str, p: &Value, thread: Option<&str>) {
    let command_ended = method == "item/completed" && p["item"]["type"] == "commandExecution";
    if method != "turn/completed" && !command_ended {
        return;
    }
    // A running Turn's own commands need no listing; its end lists once.
    if command_ended && ws.store.peek(id, |d| d.turns.iter().any(|t| t["status"] == "inProgress")).unwrap_or(false) {
        return;
    }
    if let Some(thread) = thread {
        codex_changed(ws, id, thread, command_ended);
    }
}

/// A Codex event that can start or end a background terminal: a turn end,
/// or a command ending. Lists the thread's terminals; there is no polling.
fn codex_changed(ws: &Arc<Workspace>, id: &str, thread: &str, command_ended: bool) {
    let (ws, id, thread) = (ws.clone(), id.to_owned(), thread.to_owned());
    tokio::spawn(async move {
        if check_codex(&ws, &id, &thread).await.is_some_and(|count| count > 0) && command_ended {
            tokio::time::sleep(SETTLE).await;
            check_codex(&ws, &id, &thread).await;
        }
    });
}

/// This Codex Agent's background terminals, listed now on its connection;
/// None when it has none or Codex doesn't answer (Disconnect, T-184).
pub(crate) async fn codex_count_now(ws: &Arc<Workspace>, id: &str, thread: &str) -> Option<usize> {
    check_codex(ws, id, thread).await
}

async fn check_codex(ws: &Arc<Workspace>, id: &str, thread: &str) -> Option<usize> {
    let (generation, rpc) = ws.codex_connection(id)?;
    let ticket = ws.background_shells.ticket();
    let count = list_codex(&rpc, thread).await.ok();
    if ws.background_shells.record(id, Harness::Codex, generation, ticket, count) {
        ws.changed(id);
    }
    count
}

/// Counts every page of the experimental `thread/backgroundTerminals/list`.
/// It only reads; it never starts a turn or wakes the Agent. Disconnect
/// (T-184) asks it about each sub-agent's thread too, recording nothing.
pub(crate) async fn list_codex(rpc: &Rpc, thread: &str) -> Result<usize> {
    let mut count = 0;
    let mut cursor = Value::Null;
    for _ in 0..MAX_PAGES {
        let page = rpc
            .request_within(
                "thread/backgroundTerminals/list",
                json!({"threadId":thread,"cursor":cursor,"limit":PAGE_SIZE}),
                Duration::from_secs(10),
            )
            .await?;
        count += page["data"].as_array().context("background terminal list without data")?.len();
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            return Ok(count);
        }
    }
    anyhow::bail!("background terminal list did not end")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(tasks: Value) -> Value {
        json!({"type":"system","subtype":"background_tasks_changed","tasks":tasks})
    }

    #[test]
    fn claude_snapshots_replace_the_set_and_count_only_active_shells() {
        let registry = Registry::default();
        assert!(registry.record_claude("a", 1, &snapshot(json!([
            {"task_id":"1","task_type":"local_bash","description":"dev server"},
            {"task_id":"2","task_type":"local_bash","description":"watch","ambient":true},
            {"task_id":"3","task_type":"local_agent","description":"subagent"},
        ]))));
        assert_eq!(registry.entry("a").unwrap().count, Some(1));
        // The same shells and sub-agents: nothing a reader sees changed.
        assert!(!registry.record_claude("a", 1, &snapshot(json!([
            {"task_id":"1","task_type":"local_bash","description":"dev server"},
            {"task_id":"3","task_type":"local_agent","description":"subagent"},
        ]))));
        // Its sub-agent ended (YN-51): the rail sees that, its shells unchanged.
        assert!(registry.record_claude("a", 1, &snapshot(json!([
            {"task_id":"1","task_type":"local_bash","description":"dev server"},
        ]))));
        assert_eq!(registry.entry("a").unwrap().count, Some(1));
        assert!(registry.record_claude("a", 1, &snapshot(json!([]))));
        let entry = registry.entry("a").unwrap();
        assert_eq!((entry.count, entry.last_count), (Some(0), 0));
        assert!(!registry.record_claude("a", 1, &json!({"type":"system"})));
    }

    #[test]
    fn a_task_is_running_only_as_the_latest_snapshot_of_its_generation_says() {
        let registry = Registry::default();
        assert_eq!(registry.claude_running("a", 1, "b1"), None);
        registry.record_claude("a", 1, &snapshot(json!([
            {"task_id":"b1","task_type":"local_bash","description":"sleep"},
            {"task_id":"m1","task_type":"monitor","description":"watch","ambient":true},
        ])));
        assert_eq!((registry.claude_running("a", 1, "b1"), registry.claude_running("a", 1, "m1")), (Some(true), Some(true)));
        assert_eq!(registry.claude_running("a", 1, "gone"), Some(false));
        assert_eq!(registry.claude_running("a", 2, "b1"), None, "another connection's snapshot says nothing");
        assert_eq!(registry.claude_running("b", 1, "b1"), None);
        registry.record_claude("a", 1, &snapshot(json!([])));
        assert_eq!(registry.claude_running("a", 1, "b1"), Some(false));
    }

    #[test]
    fn live_counts_come_from_each_agents_live_connection_only() {
        let registry = Registry::default();
        registry.record_claude("a", 3, &snapshot(json!([
            {"task_id":"1","task_type":"local_bash","description":"dev server"},
            {"task_id":"2","task_type":"local_agent","description":"survey"},
            {"task_id":"3","task_type":"local_agent","description":"check","ambient":true},
            {"task_id":"4","task_type":"monitor","description":"watch","ambient":true},
        ])));
        registry.record("b", Harness::Codex, 5, registry.ticket(), Some(2));
        registry.record("c", Harness::Codex, 5, registry.ticket(), Some(1));
        registry.record("c", Harness::Codex, 5, registry.ticket(), None);
        let claude = |gen: u64| move |id: &str| (id == "a").then_some(gen);
        let codex = |id: &str| matches!(id, "b" | "c").then_some(5);
        // c's last check failed: unknown is left out, never its old count.
        assert_eq!(registry.live_with(claude(3), codex),
            BTreeMap::from([("a".to_string(), (1, 1)), ("b".to_string(), (2, 0))]));
        // A newer connection's Agent: what the older one said is no longer known.
        assert_eq!(registry.live_with(claude(4), codex), BTreeMap::from([("b".to_string(), (2, 0))]));
        assert_eq!(registry.live_with(|_| None, |_| None), BTreeMap::new());
    }

    #[test]
    fn a_failed_check_is_unknown_but_remembers_the_last_count() {
        let registry = Registry::default();
        registry.record("a", Harness::Codex, 1, registry.ticket(), Some(2));
        assert!(registry.record("a", Harness::Codex, 1, registry.ticket(), None));
        let entry = registry.entry("a").unwrap();
        assert_eq!((entry.count, entry.last_count), (None, 2));
    }

    #[test]
    fn an_older_check_never_overwrites_a_newer_one() {
        let registry = Registry::default();
        let older = registry.ticket();
        let newer = registry.ticket();
        registry.record("a", Harness::Codex, 1, newer, Some(0));
        assert!(!registry.record("a", Harness::Codex, 1, older, Some(3)));
        assert_eq!(registry.entry("a").unwrap().count, Some(0));
    }
}
