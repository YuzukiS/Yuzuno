//! OpenCode 2.x's messages and events, read as Core reads a session (T-32
//! slice 3b). Core's record keeps the shape it took from 1.19.3: a user
//! message names its Turn, an answer names the message it answers
//! (`parentID`), and its parts are the Turn's items. 2.x has no `parentID`
//! and no part IDs, and writes one assistant message per step; an `idle`
//! message ends a turn: "every step since the previous marker belongs to one
//! turn, including prompts steered in while it was busy"
//! (schema/src/session-message.ts). So an answer answers the newest user
//! message before it in its turn, a text or reasoning entry is
//! `<assistant message>:<ordinal>`, and a tool its call's own ID.
//!
//! One reading for both the snapshot (`read_messages`) and the live stream
//! (`Cursor::read`), into events of the shapes Core's projection takes:
//! `message.updated` (`info`), `message.part.updated` (`part`),
//! `message.part.delta` (applied here, 2.x's text as it streams),
//! `session.status`, `session.error` and `session.created` (`info`). A
//! 1.19.3-shaped event or message is left as it is.
//!
//! 2.x's errors are `{type, message}` (schema/src/session-error.ts); Core's
//! record names them as it did, `{name, data: {message}}`. An interruption
//! (`execution.interrupted`, by the user or otherwise) is Core's aborted
//! answer, `MessageAbortedError`; a failed execution is `ExecutionFailed`.

use serde_json::{json, Value};
use std::collections::HashMap;

/// What compaction, rewind and fork say on a session whose messages are
/// 2.x's (Lead 4983, decision A): each still reads 1.19.3's, until its own
/// slice moves it. An empty session says nothing of its shape, and holds
/// nothing to rewind or fork.
pub(crate) const NOT_YET: &str = "这在 OpenCode 2.x 上还不能用（not yet on OpenCode 2.x）：Yuzuno 还读不懂 2.x 这一部分的消息";

/// The name Core's record gives a 2.x execution that failed (`halted`).
pub(crate) const EXECUTION_FAILED: &str = "ExecutionFailed";
const ABORTED: &str = "MessageAbortedError";

/// Whether a session's messages, as `/api/session/:id/message` pages them,
/// are 2.x's (`{id, type, …}`) rather than 1.19.3's (`{info, parts}`).
pub(crate) fn is_v2(messages: &Value) -> bool {
    messages.as_array().is_some_and(|all| all.iter().any(|m| m.get("info").is_none() && m["type"].is_string()))
}

/// The ID of a text or reasoning entry of an answer: never one Core keys by
/// position (record_rows.rs takes a leading `~` so).
pub(crate) fn entry_id(assistant: &str, ordinal: u64) -> String {
    format!("{assistant}:{ordinal}")
}

/// What 2.x says of an error, as Core's record names one.
fn error(native: &Value, name: Option<&str>) -> Value {
    json!({"name": name.or(native["type"].as_str()).unwrap_or("UnknownError"),
        "data": {"message": native["message"], "type": native["type"]}})
}

/// A tool's state in Core's record (`status`, `input`, `output` or `error`).
fn tool_state(status: &str, input: &Value, output: &Value, error: &Value, metadata: &Value) -> Value {
    let mut state = json!({"status": status, "input": input});
    if !output.is_null() {
        state["output"] = output.clone();
    }
    if !error.is_null() {
        state["error"] = error.clone();
    }
    if !metadata.is_null() {
        state["metadata"] = metadata.clone();
    }
    state
}

/// The text of a tool's content (`[{type: "text", text} | {type: "file", …}]`).
fn content_text(content: &Value) -> Value {
    let texts: Vec<&str> = content.as_array().into_iter().flatten().filter_map(|c| c["text"].as_str()).collect();
    if texts.is_empty() { Value::Null } else { Value::from(texts.join("\n")) }
}

fn part(id: &str, message: &str, kind: &str, text: &Value) -> Value {
    json!({"id": id, "messageID": message, "type": kind, "text": text})
}

fn tool_part(id: &str, message: &str, name: &Value, state: Value) -> Value {
    json!({"id": id, "messageID": message, "type": "tool", "tool": name, "callID": id, "state": state})
}

/// One `content` entry of a stored assistant message as Core's part.
fn content_part(assistant: &str, ordinal: usize, entry: &Value) -> Option<Value> {
    match entry["type"].as_str()? {
        kind @ ("text" | "reasoning") => Some(part(&entry_id(assistant, ordinal as u64), assistant, kind, &entry["text"])),
        "tool" => {
            let id = entry["id"].as_str()?;
            let state = &entry["state"];
            let (status, output, failure) = match state["status"].as_str() {
                Some("streaming") => ("pending", Value::Null, Value::Null),
                Some("running") => ("running", Value::Null, Value::Null),
                Some("completed") => ("completed", content_text(&state["content"]), Value::Null),
                Some("error") => ("error", Value::Null, state["error"]["message"].clone()),
                _ => ("unknown", Value::Null, Value::Null),
            };
            let input = if state["input"].is_string() && status == "pending" { json!({}) } else { state["input"].clone() };
            Some(tool_part(id, assistant, &entry["name"], tool_state(status, &input, &output, &failure, &state["metadata"])))
        }
        _ => None,
    }
}

/// An answer as Core's record takes one: the user message it answers, when
/// it started and ended, how, with what model and tokens.
fn answer(id: &str, parent: Option<&str>, created: &Value, completed: &Value, finish: &Value, error: &Value, tokens: &Value,
    model: &Value) -> Value {
    json!({"id": id, "role": "assistant", "parentID": parent, "time": {"created": created, "completed": completed},
        "finish": finish, "error": error, "tokens": tokens, "providerID": model["providerID"], "modelID": model["id"]})
}

/// A turn's end, read from its `idle` message: the user message it was the
/// turn of, and the error it ended with, if it did not succeed.
#[derive(Debug, PartialEq)]
pub(crate) struct Ended {
    pub user: String,
    pub error: Option<Value>,
}

/// A session's stored messages, oldest first, as Core reads them.
pub(crate) struct Read {
    /// Each as `{info, parts}`, an answer naming the user message it answers.
    pub messages: Vec<Value>,
    /// Each turn's end that says how it ended.
    pub ended: Vec<Ended>,
    /// The newest user message of a turn not yet ended, which the live
    /// stream goes on from (`Cursor::resumed`).
    pub open: Option<String>,
}

pub(crate) fn read_messages(messages: &Value) -> Read {
    let (mut read, mut ended) = (Vec::new(), Vec::new());
    let mut user: Option<String> = None;
    for message in messages.as_array().into_iter().flatten() {
        let Some(id) = message["id"].as_str() else { continue };
        match message["type"].as_str() {
            Some("user" | "synthetic") => {
                user = Some(id.to_owned());
                read.push(json!({"info": {"id": id, "role": "user", "time": message["time"]}, "parts": []}));
            }
            Some("assistant") => {
                let failed = if message["error"].is_object() { error(&message["error"], None) } else { Value::Null };
                let info = answer(id, user.as_deref(), &message["time"]["created"], &message["time"]["completed"], &message["finish"],
                    &failed, &message["tokens"], &message["model"]);
                let parts: Vec<Value> = message["content"].as_array().into_iter().flatten().enumerate()
                    .filter_map(|(ordinal, entry)| content_part(id, ordinal, entry)).collect();
                read.push(json!({"info": info, "parts": parts}));
            }
            Some("idle") => {
                if let Some(user) = user.take() {
                    let error = match message["outcome"].as_str() {
                        Some("interrupted") => Some(error(&message["error"], Some(ABORTED))),
                        Some("failed") => Some(error(&message["error"], Some(EXECUTION_FAILED))),
                        _ => None,
                    };
                    ended.push(Ended { user, error });
                }
            }
            _ => {}
        }
    }
    Read { messages: read, ended, open: user }
}

#[derive(Default)]
struct Step {
    parent: Option<String>,
    created: Value,
    model: Value,
}

#[derive(Default)]
struct Tool {
    message: String,
    name: Value,
    input: Value,
}

/// How long text streamed into one item gathers before it is written
/// (by the events' own times): each write is one journal row.
pub(crate) const DELTA_GATHER_MS: i64 = 250;

/// Text streamed into one item and not yet written.
struct Gathered {
    message: String,
    kind: &'static str,
    text: String,
    since: i64,
}

/// What reading one connection's live events keeps between them: the
/// newest user message of the turn now open, and of each answer, tool and
/// streaming text under way what its later events do not repeat.
#[derive(Default)]
pub(crate) struct Cursor {
    user: Option<String>,
    inputs: HashMap<String, String>,
    steps: HashMap<String, Step>,
    tools: HashMap<String, Tool>,
    gathered: HashMap<String, Gathered>,
}

impl Cursor {
    /// After a whole read: what the live stream goes on from is the turn
    /// that read found open, if any; nothing of before it is kept.
    pub(crate) fn resumed(&mut self, open: Option<String>) {
        *self = Self { user: open, ..Self::default() };
    }

    /// The events of Core's shape one 2.x event stands for, in order. A
    /// 1.19.3-shaped one is returned as it is; one Core takes nothing from,
    /// none.
    pub(crate) fn read(&mut self, event: &Value) -> Vec<Value> {
        let kind = event["type"].as_str().unwrap_or_default();
        let d = &event["data"];
        let session = &d["sessionID"];
        let at = &event["created"];
        let made = |kind: &str, data: Value| json!({"id": event["id"], "type": kind, "data": data});
        let message = |info: Value| made("message.updated", json!({"sessionID": session, "info": info}));
        let updated = |part: Value| made("message.part.updated", json!({"sessionID": session, "part": part}));
        let status = |kind: &str| made("session.status", json!({"sessionID": session, "status": {"type": kind}}));
        let failed = |error: Value| made("session.error", json!({"sessionID": session, "error": error}));
        match kind {
            "session.created" if d.get("info").is_none() => vec![made("session.created", json!({"sessionID": session,
                "info": {"id": session, "parentID": d["parentID"], "title": d["title"], "agent": d["agent"]}}))],
            "session.inbox.enqueued" => {
                if let (Some(id), Some(item)) = (d["inboxID"].as_str(), d["item"]["type"].as_str()) {
                    self.inputs.insert(id.to_owned(), item.to_owned());
                }
                vec![]
            }
            "session.inbox.delivered" => {
                let Some(id) = d["inboxID"].as_str() else { return vec![] };
                // Only a user's or a synthetic input is a message a turn's answers can answer.
                if !matches!(self.inputs.remove(id).as_deref(), None | Some("user" | "synthetic")) {
                    return vec![];
                }
                self.user = Some(id.to_owned());
                vec![message(json!({"id": id, "role": "user", "time": {"created": at}}))]
            }
            "session.step.started" => {
                let Some(id) = d["assistantMessageID"].as_str() else { return vec![] };
                let step = Step { parent: self.user.clone(), created: at.clone(), model: d["model"].clone() };
                let info = answer(id, step.parent.as_deref(), &step.created, &Value::Null, &Value::Null, &Value::Null, &Value::Null, &step.model);
                self.steps.insert(id.to_owned(), step);
                vec![message(info)]
            }
            "session.step.ended" | "session.step.failed" => {
                let Some(id) = d["assistantMessageID"].as_str() else { return vec![] };
                let step = self.steps.remove(id).unwrap_or_else(|| Step { parent: self.user.clone(), ..Default::default() });
                let failure = if kind == "session.step.failed" { error(&d["error"], None) } else { Value::Null };
                vec![message(answer(id, step.parent.as_deref(), &step.created, at, &d["finish"], &failure, &d["tokens"], &step.model))]
            }
            "session.text.started" | "session.text.ended" | "session.reasoning.started" | "session.reasoning.ended" => {
                let (Some(message), Some(ordinal)) = (d["assistantMessageID"].as_str(), d["ordinal"].as_u64()) else { return vec![] };
                let entry = if kind.starts_with("session.text") { "text" } else { "reasoning" };
                let id = entry_id(message, ordinal);
                // The whole text replaces what streamed, and what had not been written yet.
                let text = if kind.ends_with(".ended") { self.gathered.remove(&id); d["text"].clone() } else { Value::from("") };
                vec![updated(part(&id, message, entry, &text))]
            }
            "session.text.delta" | "session.reasoning.delta" => {
                let (Some(message), Some(ordinal), Some(added)) = (d["assistantMessageID"].as_str(), d["ordinal"].as_u64(), d["delta"].as_str())
                    else { return vec![] };
                let id = entry_id(message, ordinal);
                let now = at.as_i64().unwrap_or_default();
                let gathered = self.gathered.entry(id.clone()).or_insert_with(|| Gathered {
                    message: message.to_owned(), kind: if kind == "session.text.delta" { "text" } else { "reasoning" }, text: String::new(), since: now });
                gathered.text.push_str(added);
                if now - gathered.since < DELTA_GATHER_MS {
                    return vec![];
                }
                let Gathered { message, kind, text, .. } = self.gathered.remove(&id).expect("gathered");
                vec![made("message.part.delta", json!({"sessionID": session, "messageID": message, "partID": id, "type": kind, "delta": text}))]
            }
            "session.tool.input.started" | "session.tool.called" | "session.tool.progress" | "session.tool.success" | "session.tool.failed" => {
                let (Some(message), Some(id)) = (d["assistantMessageID"].as_str(), d["id"].as_str()) else { return vec![] };
                let tool = self.tools.entry(id.to_owned()).or_insert_with(|| Tool { message: message.to_owned(), ..Default::default() });
                if d["name"].is_string() {
                    tool.name = d["name"].clone();
                }
                if d["input"].is_object() {
                    tool.input = d["input"].clone();
                }
                let input = if tool.input.is_null() { json!({}) } else { tool.input.clone() };
                let state = match kind {
                    "session.tool.input.started" => tool_state("pending", &input, &Value::Null, &Value::Null, &Value::Null),
                    "session.tool.success" => tool_state("completed", &input, &content_text(&d["content"]), &Value::Null, &d["metadata"]),
                    "session.tool.failed" => tool_state("error", &input, &Value::Null, &d["error"]["message"], &d["metadata"]),
                    _ => tool_state("running", &input, &Value::Null, &Value::Null, &d["metadata"]),
                };
                let read = vec![updated(tool_part(id, &tool.message, &tool.name, state))];
                if matches!(kind, "session.tool.success" | "session.tool.failed") {
                    self.tools.remove(id);
                }
                read
            }
            "session.execution.started" => vec![status("busy")],
            "session.retry.scheduled" => vec![status("retry")],
            "session.execution.succeeded" => self.ended(vec![status("idle")]),
            "session.execution.failed" => self.ended(vec![failed(error(&d["error"], Some(EXECUTION_FAILED))), status("idle")]),
            // A shutdown leaves the turn open: the execution resumes it (session-message.ts), and a Core that restarts reads it unknown.
            "session.execution.interrupted" if d["reason"] == "shutdown" => vec![],
            "session.execution.interrupted" => {
                let reason = Value::from(format!("interrupted ({})", d["reason"].as_str().unwrap_or("unknown")));
                self.ended(vec![failed(error(&json!({"type": "interrupted", "message": reason}), Some(ABORTED))), status("idle")])
            }
            _ if kind.starts_with("session.") && !is_v1_kind(kind) => vec![],
            _ => vec![event.clone()],
        }
    }

    /// A terminal execution event: its turn is over, and the next steps belong to the next one.
    fn ended(&mut self, read: Vec<Value>) -> Vec<Value> {
        self.user = None;
        self.steps.clear();
        self.tools.clear();
        self.gathered.clear();
        read
    }
}

/// The session event types 1.19.3 sent and Core reads as they are (the
/// stand-in's 1.19.3 mode, until compaction, revert and fork move).
fn is_v1_kind(kind: &str) -> bool {
    matches!(kind, "session.created" | "session.updated" | "session.status" | "session.error" | "session.idle")
}

/// Applies a 2.x text or reasoning delta to the item it streams into,
/// making it if its start was not seen. `items` are a Turn's.
pub(crate) fn apply_delta(items: &mut Vec<Value>, delta: &Value) {
    let (Some(id), Some(message), Some(added)) = (delta["partID"].as_str(), delta["messageID"].as_str(), delta["delta"].as_str()) else { return };
    let reasoning = delta["type"] == "reasoning";
    let item = match items.iter_mut().position(|i| i["id"] == id) {
        Some(at) => &mut items[at],
        None => {
            items.push(if reasoning { json!({"id": id, "type": "reasoning", "summary": [""], "nativeMessageId": message}) }
                else { json!({"id": id, "type": "agentMessage", "text": "", "nativeMessageId": message}) });
            items.last_mut().expect("pushed")
        }
    };
    let slot = if reasoning { &mut item["summary"][0] } else { &mut item["text"] };
    let mut text = slot.as_str().unwrap_or_default().to_owned();
    text.push_str(added);
    *slot = text.into();
}

#[cfg(test)]
#[path = "opencode_v2_tests.rs"]
mod tests;
