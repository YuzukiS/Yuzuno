//! A Codex Agent's background terminals (T-29 `/ps` and `/stop`): the
//! commands Codex keeps running in its conversation after their tool call
//! returned, as Codex 0.162.1 lists them (experimental
//! `thread/backgroundTerminals/list`), and a stop of the ones the user chose.
//!
//! Measured on the 0.162.1 source (T-29 comment 5749):
//! - A terminal is named by Codex's own process number, random and reused
//!   once its process left Codex's store, and by `itemId`, the tool call that
//!   started it. The pair is what the user saw and what is stopped.
//! - `terminate {threadId, processId}` stops one process: false when the
//!   number is unknown or the stop failed.
//! - `clean` queues a stop of every process in the store when it runs, so a
//!   terminal started after the list was shown would be stopped too: it is
//!   not used.
//!
//! Everything runs on the Agent's current connection only: nothing is
//! connected or resumed for it, the Turn is never interrupted, and an
//! answer that did not come is never sent again.
use crate::{
    rpc::{Rpc, RpcError},
    server::ApiError,
    workspace::Workspace,
};
use anyhow::Result;
use axum::{
    extract::{Path, State as ApiState},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::Duration,
};

const PAGE_SIZE: u64 = 100;
/// Pages read at most: a list longer than this is said to be incomplete.
const MAX_PAGES: usize = 20;
const LIST_WITHIN: Duration = Duration::from_secs(10);
/// A stop waits for Codex to confirm the process ended.
const STOP_WITHIN: Duration = Duration::from_secs(15);
/// Terminals one stop may name.
const MAX_TARGETS: usize = 100;
const MAX_ITEM_ID: usize = 256;

/// Agents with a stop in progress: one at a time each.
#[derive(Default)]
pub(crate) struct State {
    stopping: Mutex<HashSet<String>>,
}

/// One background terminal as Codex lists it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Terminal {
    process_id: String,
    item_id: String,
    command: String,
    cwd: String,
    /// Started by a command of the Turn that is still running: stopping it
    /// can change what that Turn is doing.
    in_running_turn: bool,
}

/// The Agent's background terminals as listed now.
#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// listed, unavailable or failed.
    state: &'static str,
    reason: String,
    detail: Option<String>,
    generation: Option<u64>,
    thread_id: Option<String>,
    terminals: Vec<Terminal>,
    /// Every page was read.
    complete: bool,
}

impl Listing {
    fn not(state: &'static str, reason: &str) -> Self {
        Self { state, reason: reason.into(), ..Default::default() }
    }
}

/// Why a request had no answer to use.
#[derive(Debug)]
enum Failure {
    /// This Codex has no such request (JSON-RPC -32601).
    Unsupported,
    Refused(String),
    /// No answer: the connection ended or the answer did not come in time.
    NoAnswer(String),
}

fn failure(error: anyhow::Error) -> Failure {
    match error.downcast_ref::<RpcError>() {
        Some(refused) if refused.code == -32601 => Failure::Unsupported,
        Some(refused) => Failure::Refused(refused.message.chars().take(500).collect()),
        None => Failure::NoAnswer(error.to_string().chars().take(500).collect()),
    }
}

/// Every page of the thread's terminals, up to MAX_PAGES; whether all were read.
async fn list(rpc: &Rpc, thread: &str) -> std::result::Result<(Vec<Value>, bool), Failure> {
    let mut terminals = vec![];
    let mut cursor = Value::Null;
    for _ in 0..MAX_PAGES {
        let page = rpc
            .request_within("thread/backgroundTerminals/list", json!({"threadId":thread,"cursor":cursor,"limit":PAGE_SIZE}), LIST_WITHIN)
            .await
            .map_err(failure)?;
        let Some(data) = page["data"].as_array() else {
            return Err(Failure::Refused("a list without data".into()));
        };
        terminals.extend(data.iter().cloned());
        cursor = page["nextCursor"].clone();
        if cursor.is_null() {
            return Ok((terminals, true));
        }
    }
    Ok((terminals, false))
}

fn same(terminal: &Value, target: &Target) -> bool {
    terminal["processId"].as_str() == Some(target.process_id.as_str())
}

/// One terminal the user chose: the pair the dialog showed.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Target {
    pub(crate) process_id: String,
    pub(crate) item_id: String,
}

/// A stop of the terminals the dialog showed, on the connection and
/// conversation it showed them for.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StopRequest {
    pub(crate) generation: u64,
    pub(crate) thread_id: String,
    pub(crate) targets: Vec<Target>,
}

/// What became of one target.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    process_id: String,
    item_id: String,
    /// stopped; gone (not in a complete list before the stop, or after one
    /// Codex did not make); replaced (its number now names another terminal;
    /// not sent); not_stopped (Codex did not stop it and it is still listed,
    /// or `unchecked`: no complete list said it ended); refused; unsupported;
    /// unknown (no answer: whether it stopped is not known, and it is not
    /// sent again); not_sent (`unlisted`: not in the part of an incomplete
    /// list that was read; otherwise the connection changed or an earlier
    /// target's outcome stopped the rest).
    outcome: &'static str,
    /// Whether a terminate was sent for it.
    sent: bool,
    detail: Option<String>,
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StopReport {
    /// done, unavailable or busy.
    state: &'static str,
    reason: String,
    generation: Option<u64>,
    outcomes: Vec<Outcome>,
    /// A fresh list after the stops: a check, nothing is done with it.
    after: Option<Listing>,
}

impl StopReport {
    fn not(state: &'static str, reason: &str) -> Self {
        Self { state, reason: reason.into(), ..Default::default() }
    }
}

/// Removes the Agent from those stopping when its stop ends, however it ends.
struct Stopping<'a> {
    ws: &'a Workspace,
    id: String,
}

impl Drop for Stopping<'_> {
    fn drop(&mut self) {
        self.ws.codex_terminals.stopping.lock().unwrap().remove(&self.id);
    }
}

impl Workspace {
    /// The Agent's current Codex connection and conversation, or why there
    /// is none. Nothing is connected or resumed.
    async fn codex_terminals_on(&self, id: &str) -> Result<std::result::Result<(u64, Arc<Rpc>, String), &'static str>> {
        let agent = self.listed(id).await?;
        if agent.harness != "codex" {
            return Ok(Err("harness"));
        }
        if agent.closed_at.is_some() {
            return Ok(Err("closed"));
        }
        let connection = self.rpcs.lock().unwrap().get(id).filter(|c| !c.closing && agent.connection_state == "connected")
            .map(|c| (c.generation, c.rpc.clone()));
        let Some((generation, rpc)) = connection else { return Ok(Err("not_connected")) };
        let Some(thread) = agent.thread_id else { return Ok(Err("no_thread")) };
        Ok(Ok((generation, rpc, thread)))
    }

    fn codex_terminals_listing(&self, id: &str, generation: u64, thread: &str, (data, complete): (Vec<Value>, bool)) -> Listing {
        // The items of a Turn still running (held records only: no history is read for this).
        let running: HashMap<String, ()> = self.store.peek(id, |d| d.turns.iter()
            .filter(|t| t["status"] == "inProgress")
            .flat_map(|t| t["items"].as_array().into_iter().flatten().filter_map(|i| i["id"].as_str().map(|s| (s.to_owned(), ()))))
            .collect()).unwrap_or_default();
        let text = |v: &Value| v.as_str().unwrap_or_default().chars().take(4000).collect::<String>();
        let terminals = data.iter().filter(|t| t["processId"].is_string()).map(|t| Terminal {
            process_id: text(&t["processId"]),
            item_id: text(&t["itemId"]),
            command: text(&t["command"]),
            cwd: text(&t["cwd"]),
            in_running_turn: t["itemId"].as_str().is_some_and(|item| running.contains_key(item)),
        }).collect();
        Listing { state: "listed", reason: "listed".into(), generation: Some(generation), thread_id: Some(thread.into()), terminals, complete, ..Default::default() }
    }

    /// This Codex Agent's background terminals, read now on its current connection.
    pub async fn codex_terminals(&self, id: &str) -> Result<Listing> {
        let (generation, rpc, thread) = match self.codex_terminals_on(id).await? {
            Ok(on) => on,
            Err(reason) => return Ok(Listing::not("unavailable", reason)),
        };
        Ok(match list(&rpc, &thread).await {
            Ok(listed) => self.codex_terminals_listing(id, generation, &thread, listed),
            Err(Failure::Unsupported) => Listing { generation: Some(generation), ..Listing::not("unavailable", "old_protocol") },
            Err(Failure::Refused(detail)) => Listing { detail: Some(detail), generation: Some(generation), ..Listing::not("failed", "refused") },
            Err(Failure::NoAnswer(detail)) => Listing { detail: Some(detail), generation: Some(generation), ..Listing::not("failed", "no_answer") },
        })
    }

    /// Stops the terminals the user chose, each only if a list read just
    /// before still names it as the dialog showed it. One terminate per
    /// terminal; never `clean`; nothing is sent again.
    pub async fn codex_terminals_stop(&self, id: &str, request: StopRequest) -> Result<StopReport> {
        let StopRequest { generation, thread_id, targets } = request;
        anyhow::ensure!(!targets.is_empty() && targets.len() <= MAX_TARGETS, "要停止的后台终端数量无效");
        let mut seen = HashSet::new();
        for target in &targets {
            anyhow::ensure!(target.process_id.parse::<i32>().is_ok_and(|n| n >= 0) && !target.process_id.starts_with('+'), "无效的后台终端编号");
            anyhow::ensure!(!target.item_id.is_empty() && target.item_id.len() <= MAX_ITEM_ID, "无效的后台终端来源");
            anyhow::ensure!(seen.insert(target.process_id.clone()), "同一后台终端不能重复停止");
        }
        let (current, rpc, thread) = match self.codex_terminals_on(id).await? {
            Ok(on) => on,
            Err(reason) => return Ok(StopReport::not("unavailable", reason)),
        };
        if current != generation || thread != thread_id {
            return Ok(StopReport { generation: Some(current), ..StopReport::not("unavailable", "target_changed") });
        }
        if !self.codex_terminals.stopping.lock().unwrap().insert(id.to_owned()) {
            return Ok(StopReport::not("busy", "busy"));
        }
        let _stopping = Stopping { ws: self, id: id.to_owned() };
        let mut outcomes = vec![];
        let mut halted: Option<&'static str> = None;
        for target in targets {
            let outcome = |outcome: &'static str, sent: bool, detail: Option<String>| Outcome {
                process_id: target.process_id.clone(), item_id: target.item_id.clone(), outcome, sent, detail,
            };
            if halted.is_some() {
                outcomes.push(outcome("not_sent", false, halted.map(str::to_owned)));
                continue;
            }
            // Only on the connection the dialog showed.
            if self.codex_connection(id).map(|(g, _)| g) != Some(generation) {
                halted = Some("connection");
                outcomes.push(outcome("not_sent", false, Some("connection".into())));
                continue;
            }
            // Still the terminal the user saw: listed, with the same tool call.
            let (before, complete) = match list(&rpc, &thread).await {
                Ok(listed) => listed,
                Err(failed) => {
                    let (name, detail) = match failed {
                        Failure::Unsupported => ("unsupported", None),
                        Failure::Refused(detail) => ("refused", Some(detail)),
                        Failure::NoAnswer(detail) => ("unknown", Some(detail)),
                    };
                    // The check had no answer: nothing was sent, so this one is not_sent.
                    halted = Some(name);
                    outcomes.push(outcome("not_sent", false, Some(format!("{name}{}", detail.map(|d| format!(": {d}")).unwrap_or_default()))));
                    continue;
                }
            };
            match before.iter().find(|t| same(t, &target)) {
                // Only a complete list shows it ended; one cut short may hold it in a page not read.
                None if complete => {
                    outcomes.push(outcome("gone", false, None));
                    continue;
                }
                None => {
                    outcomes.push(outcome("not_sent", false, Some("unlisted".into())));
                    continue;
                }
                Some(listed) if listed["itemId"].as_str() != Some(target.item_id.as_str()) => {
                    outcomes.push(outcome("replaced", false, None));
                    continue;
                }
                Some(_) => {}
            }
            // Still the Agent's connection, and still running, now that the check answered: a
            // connection only stops taking requests once it no longer runs. This is a lookup,
            // not a lock held to the write: one that ends after it ends with the terminate in
            // flight (unknown, never sent again).
            if !self.codex_connection(id).is_some_and(|(g, current)| g == generation && Arc::ptr_eq(&current, &rpc)) || !rpc.is_running() {
                halted = Some("connection");
                outcomes.push(outcome("not_sent", false, Some("connection".into())));
                continue;
            }
            let answer = rpc.request_within("thread/backgroundTerminals/terminate",
                json!({"threadId":thread,"processId":target.process_id}), STOP_WITHIN).await;
            match answer {
                Ok(answer) if answer["terminated"] == true => outcomes.push(outcome("stopped", true, None)),
                Ok(_) => {
                    // Not stopped: gone meanwhile, or Codex could not stop it; a complete list tells which.
                    let still = list(&rpc, &thread).await.ok().map(|(data, complete)| (data.iter().any(|t| same(t, &target)), complete));
                    outcomes.push(match still {
                        Some((false, true)) => outcome("gone", true, None),
                        Some((true, _)) => outcome("not_stopped", true, None),
                        _ => outcome("not_stopped", true, Some("unchecked".into())),
                    });
                }
                Err(error) => match failure(error) {
                    Failure::Unsupported => {
                        halted = Some("unsupported");
                        outcomes.push(outcome("unsupported", true, None));
                    }
                    Failure::Refused(detail) => outcomes.push(outcome("refused", true, Some(detail))),
                    Failure::NoAnswer(detail) => {
                        // Whether it stopped is not known; nothing more is sent on this connection.
                        halted = Some("unknown");
                        outcomes.push(outcome("unknown", true, Some(detail)));
                    }
                },
            }
        }
        // A fresh list, as a check of what is still running.
        let after = if self.codex_connection(id).map(|(g, _)| g) == Some(generation) {
            Some(match list(&rpc, &thread).await {
                Ok(listed) => self.codex_terminals_listing(id, generation, &thread, listed),
                Err(Failure::Unsupported) => Listing::not("unavailable", "old_protocol"),
                Err(Failure::Refused(detail)) => Listing { detail: Some(detail), ..Listing::not("failed", "refused") },
                Err(Failure::NoAnswer(detail)) => Listing { detail: Some(detail), ..Listing::not("failed", "no_answer") },
            })
        } else {
            None
        };
        Ok(StopReport { state: "done", reason: "done".into(), generation: Some(generation), outcomes, after })
    }
}

async fn list_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<Listing>, ApiError> {
    Ok(Json(ws.codex_terminals(&id).await?))
}

async fn stop_route(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Json(request): Json<StopRequest>) -> Result<Json<StopReport>, ApiError> {
    Ok(Json(ws.codex_terminals_stop(&id, request).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/agents/{id}/codex/terminals", get(list_route))
        .route("/api/agents/{id}/codex/terminals/stop", post(stop_route))
}
