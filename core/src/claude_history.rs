//! What Claude saved of a session this Agent resumed, filled in where the
//! record lacks it (T-22). The bridge reads the session through the SDK's
//! session readers (`history_read`, then `history_index` for each message's
//! identity and `history_messages` for those needed); `claude::claude_backfill`
//! drives it after a reconnect.
//!
//! Only what Claude saved is shown: a reply it streamed but never saved stays
//! as streamed and says so, and a turn whose saved messages stop short ends
//! unknown. A message is matched by its identity, never by text or position:
//! a prompt by the uuid it was sent with (the Yuzuno turn's id, or a
//! follow-up's `follow_up_uuid`), Claude's output by its frame uuid, API
//! message id and tool call ids. Messages from before the first one the
//! record holds are not filled in; only a native session import
//! (`plan_import`, `claude_sessions`) takes a saved session whole.
//! A prompt nothing in the record names was sent outside Yuzuno, for example
//! in a terminal resuming the same session: it starts a turn of its own,
//! shown as such. Tool results, meta and system messages, and local commands
//! are never shown as user messages.
use crate::claude;
use crate::model::AgentDetail;
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// One saved message's identity, as the bridge's `history_index` gives it.
#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub offset: usize,
    #[serde(default)]
    pub uuid: Option<String>,
    #[serde(rename = "type", default)]
    pub kind: String,
    /// Set for a sub-agent's own message.
    #[serde(default)]
    pub agent_id: Option<String>,
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    /// The API message id of an assistant message.
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub blocks: Vec<Block>,
    /// The start of a prompt's text.
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub flags: Flags,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Block {
    #[serde(rename = "type", default)]
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub tool_use_id: Option<String>,
}

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Flags {
    #[serde(default)]
    pub meta: bool,
    #[serde(default)]
    pub compact_summary: bool,
    #[serde(default)]
    pub local_command: bool,
    /// Written by Claude Code, not the model (`model: "<synthetic>"`), such
    /// as the "No response requested." it saves for a turn cut off.
    #[serde(default)]
    pub synthetic: bool,
}

/// What a saved main-chain message is to the conversation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    /// A prompt someone sent.
    Prompt,
    /// Claude's output: text, thinking or tool calls.
    Output,
    /// Tool results (a denial included): evidence on their calls.
    Results,
    /// The summary that starts a compacted conversation.
    Compaction,
    /// System, meta and local-command messages: not conversation.
    Other,
}

fn kind(e: &Entry) -> Kind {
    match e.kind.as_str() {
        "assistant" if e.flags.synthetic => Kind::Other,
        "assistant" => Kind::Output,
        "user" if e.blocks.iter().any(|b| b.kind == "tool_result") => Kind::Results,
        "user" if e.flags.compact_summary => Kind::Compaction,
        "user" if e.flags.meta || e.flags.local_command => Kind::Other,
        "user" => Kind::Prompt,
        _ => Kind::Other,
    }
}

/// The uuid a follow-up is sent with, from its client message id: Claude
/// saves the prompt under it, so its saved history names it.
pub(crate) fn follow_up_uuid(client_id: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("yuzuno-claude-follow-up\n{client_id}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Builder::from_random_bytes(bytes).into_uuid().to_string()
}

/// What the record already holds, by native identity, and where.
#[derive(Default)]
struct Known {
    prompts: HashMap<String, String>,
    /// Claude's assistant frames by uuid (`_claudeAssistantSeen`): each is
    /// one saved message, one content block.
    frames: HashMap<String, String>,
    /// Message ids with completed text, in turns recorded before frame uuids
    /// were kept (no `_claudeAssistantSeen`): there a message id is all
    /// there is to go by. Elsewhere text is known by its frame uuid only:
    /// one message's text blocks are separate saved messages.
    texts: HashMap<String, String>,
    /// Message ids with thinking, in turns that ended: their thinking was
    /// complete. In a cut-off turn a reasoning item may hold only the start
    /// that streamed, so there thinking is known by its frame uuid only.
    thinking: HashMap<String, String>,
    /// Tool calls: their turn, whether the call itself was seen, whether its result was.
    calls: HashMap<String, (String, bool, bool)>,
    /// Items by id (compaction markers are their message's uuid).
    items: HashMap<String, String>,
}

impl Known {
    fn of(d: &AgentDetail) -> Self {
        let mut known = Known::default();
        for turn in &d.turns {
            known.add(turn);
        }
        known
    }

    /// Everything this turn holds (adding is enough: items only grow).
    fn add(&mut self, turn: &Value) {
        let Some(tid) = turn["id"].as_str() else { return };
        let tracked = turn["_claudeAssistantSeen"].is_object();
        let ended = matches!(turn["status"].as_str(), Some("completed" | "failed" | "interrupted"));
        for uuid in turn["_claudeAssistantSeen"].as_object().into_iter().flatten().map(|(k, _)| k) {
            self.frames.insert(uuid.clone(), tid.to_owned());
        }
        for item in turn["items"].as_array().into_iter().flatten() {
            let Some(id) = item["id"].as_str() else { continue };
            self.items.insert(id.to_owned(), tid.to_owned());
            match item["type"].as_str() {
                // The uuid a prompt was sent with (`claude_send` records it),
                // or a follow-up's, from its client id.
                Some("userMessage") => {
                    if let Some(uuid) = item["nativeUuid"].as_str() {
                        self.prompts.insert(uuid.to_owned(), tid.to_owned());
                    }
                    if let Some(client) = item["clientId"].as_str() {
                        self.prompts.insert(follow_up_uuid(client), tid.to_owned());
                    }
                }
                Some("agentMessage") if !tracked && !item["_yuzunoCompletedText"].is_null() => {
                    self.texts.insert(id.to_owned(), tid.to_owned());
                }
                Some("reasoning") if ended => {
                    if let Some(mid) = id.strip_suffix(":thinking") {
                        self.thinking.insert(mid.to_owned(), tid.to_owned());
                    }
                }
                Some("claudeToolUse") => {
                    // The call itself is complete only from Claude's
                    // assistant frame (which sets nativeMessageId): a call
                    // that started streaming already has a name and `{}` as
                    // its input before its arguments arrive.
                    let called = item["nativeMessageId"].is_string();
                    let answered = !item["output"].is_null();
                    self.calls.insert(id.to_owned(), (tid.to_owned(), called, answered));
                }
                _ => {}
            }
        }
    }

    /// The turn holding this saved message, if the record has it all.
    fn turn_of(&self, e: &Entry) -> Option<String> {
        let uuid = e.uuid.as_deref().unwrap_or("");
        match kind(e) {
            Kind::Prompt => self.prompts.get(uuid).cloned(),
            Kind::Compaction => self.items.get(uuid).cloned(),
            Kind::Results => {
                let mut turn = None;
                for block in e.blocks.iter().filter(|b| b.kind == "tool_result") {
                    let (tid, _, answered) = self.calls.get(block.tool_use_id.as_deref()?)?;
                    if !answered {
                        return None;
                    }
                    turn = Some(tid.clone());
                }
                turn
            }
            Kind::Output => {
                if let Some(tid) = self.frames.get(uuid) {
                    return Some(tid.clone());
                }
                let mid = e.id.as_deref().unwrap_or("");
                let mut turn = None;
                for block in &e.blocks {
                    let found = match block.kind.as_str() {
                        // A sub-agent's text and thinking are not shown.
                        "text" | "thinking" | "redacted_thinking" if e.agent_id.is_some() || e.parent_tool_use_id.is_some() => continue,
                        "text" => self.texts.get(mid),
                        "thinking" | "redacted_thinking" => self.thinking.get(mid).or_else(|| self.texts.get(mid)),
                        "tool_use" => self.calls.get(block.id.as_deref()?).filter(|(_, called, _)| *called).map(|(tid, _, _)| tid),
                        _ => continue,
                    };
                    turn = Some(found?.clone());
                }
                // Nothing in it is shown (a sub-agent's text only): nothing to add.
                turn.or_else(|| e.parent_tool_use_id.as_deref().and_then(|call| self.calls.get(call)).map(|(tid, _, _)| tid.clone()))
            }
            Kind::Other => None,
        }
    }

    /// The turn of a tool call this message answers, when the call is known.
    fn call_turn(&self, e: &Entry) -> Option<String> {
        e.blocks.iter().filter_map(|b| b.tool_use_id.as_deref()).find_map(|id| self.calls.get(id)).map(|(tid, _, _)| tid.clone())
    }
}

/// One step of a backfill, in saved order.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Step {
    /// A prompt sent outside Yuzuno: a turn of its own, `native-<uuid>`.
    Outside { offset: usize, turn: String },
    /// A saved message the record lacks, projected into `turn`.
    Message { offset: usize, turn: String },
    /// A compaction (its summary message): a marker in `turn`.
    Compaction { offset: usize, turn: String },
    /// Text of a cut-off turn that streamed live but that Claude never saved
    /// (a turn killed mid-reply saves nothing of it): shown, marked so.
    Unsaved { turn: String, item: String },
}

impl Step {
    /// The saved message this step needs, if any.
    pub(crate) fn offset(&self) -> Option<usize> {
        match self {
            Step::Outside { offset, .. } | Step::Message { offset, .. } | Step::Compaction { offset, .. } => Some(*offset),
            Step::Unsaved { .. } => None,
        }
    }
}

#[derive(Debug, Default, PartialEq)]
pub(crate) struct Plan {
    pub steps: Vec<Step>,
    /// Saved history names nothing this record holds: nothing is imported.
    pub unmatched: bool,
}

/// What to add, from every saved message's identity: main-chain messages
/// first (in saved order), then sub-agents' messages under their calls.
pub(crate) fn plan(d: &AgentDetail, entries: &[Entry]) -> Plan {
    plan_from(d, entries, false)
}

/// For a native session import: the new record holds none of the session,
/// so all of it is new, from its first saved message. Output saved before
/// any prompt has no turn to go in and is left out (`import_gaps`).
pub(crate) fn plan_import(d: &AgentDetail, entries: &[Entry]) -> Plan {
    plan_from(d, entries, true)
}

/// What an import plan leaves out of the saved main chain: conversation
/// with no turn to go in (before its first prompt), and whether the chain
/// starts at a compaction summary (what came before it is not in the chain).
pub(crate) fn import_gaps(entries: &[Entry], plan: &Plan) -> (usize, bool) {
    let planned: HashSet<usize> = plan.steps.iter().filter_map(Step::offset).collect();
    let main: Vec<&Entry> = entries.iter().filter(|e| e.agent_id.is_none() && kind(e) != Kind::Other).collect();
    let compacted = main.first().is_some_and(|e| kind(e) == Kind::Compaction);
    let left = main.iter().filter(|e| kind(e) != Kind::Compaction && !planned.contains(&e.offset)).count();
    (left, compacted)
}

fn plan_from(d: &AgentDetail, entries: &[Entry], whole: bool) -> Plan {
    let known = Known::of(d);
    let main: Vec<&Entry> = entries.iter().filter(|e| e.agent_id.is_none()).collect();
    let anchor = main.iter().position(|e| known.turn_of(e).is_some());
    // After a compaction the chain starts at its summary; what follows is new
    // when none of it is in the record (it was compacted outside Yuzuno).
    let compacted = main.iter().position(|e| kind(e) != Kind::Other).filter(|&i| kind(main[i]) == Kind::Compaction);
    let Some(start) = anchor.or(compacted).or(whole.then_some(0)) else {
        return Plan { steps: vec![], unmatched: main.iter().any(|e| kind(e) != Kind::Other) };
    };
    let mut steps = Vec::new();
    let mut cursor: Option<String> = if anchor.is_some() { None } else { d.turns.last().and_then(|t| t["id"].as_str().map(str::to_owned)) };
    let mut claimed: HashSet<String> = HashSet::new();
    for (i, e) in main.iter().enumerate().skip(start) {
        if let Some(tid) = known.turn_of(e) {
            cursor = Some(tid);
            continue;
        }
        match kind(e) {
            Kind::Other => {}
            Kind::Prompt => {
                let Some(uuid) = e.uuid.as_deref() else { continue };
                // Answered by output the record holds: a prompt Yuzuno sent
                // before it kept prompt uuids. The known output moves the cursor.
                let next = main[i + 1..].iter().position(|n| kind(n) == Kind::Prompt).map_or(main.len(), |p| i + 1 + p);
                // What it holds that the record lacks goes to that turn too.
                if let Some(tid) = main[i + 1..next].iter().find_map(|n| known.turn_of(n)) {
                    cursor = Some(tid);
                    continue;
                }
                // A prompt Yuzuno sent before it kept prompt uuids, whose reply
                // it never saw: that turn, by the prompt's own text.
                if let Some(tid) = unanswered_turn(d, e, &claimed) {
                    claimed.insert(tid.clone());
                    cursor = Some(tid);
                    continue;
                }
                let turn = format!("native-{uuid}");
                steps.push(Step::Outside { offset: e.offset, turn: turn.clone() });
                cursor = Some(turn);
            }
            Kind::Compaction => {
                if let Some(turn) = cursor.clone() {
                    steps.push(Step::Compaction { offset: e.offset, turn });
                }
            }
            Kind::Output | Kind::Results => {
                if let Some(turn) = known.call_turn(e).or_else(|| cursor.clone()) {
                    steps.push(Step::Message { offset: e.offset, turn });
                }
            }
        }
    }
    // A sub-agent's own messages go with its call: one the record holds, or
    // one this backfill adds. A call neither knows stays unattributed.
    let mut calls: HashMap<&str, String> = known.calls.iter().map(|(id, (tid, _, _))| (id.as_str(), tid.clone())).collect();
    let by_offset: HashMap<usize, &Entry> = entries.iter().map(|e| (e.offset, e)).collect();
    for step in &steps {
        if let Step::Message { offset, turn } = step {
            for block in by_offset[offset].blocks.iter().filter(|b| b.kind == "tool_use") {
                if let Some(id) = block.id.as_deref() {
                    calls.entry(id).or_insert_with(|| turn.clone());
                }
            }
        }
    }
    for e in entries.iter().filter(|e| e.agent_id.is_some()) {
        if known.turn_of(e).is_some() || kind(e) == Kind::Other || kind(e) == Kind::Prompt {
            continue;
        }
        if let Some(turn) = e.parent_tool_use_id.as_deref().and_then(|call| calls.get(call)) {
            steps.push(Step::Message { offset: e.offset, turn: turn.clone() });
        }
    }
    // A cut-off turn the saved history covers: reply text it streamed that
    // Claude never saved (no saved message has its id) is marked so.
    let covered: HashSet<String> = main.iter().skip(start).filter_map(|e| known.turn_of(e)).collect();
    let saved_ids: HashSet<&str> = entries.iter().filter_map(|e| e.id.as_deref()).collect();
    for turn in d.turns.iter().filter(|t| t["status"] == "outcomeUnknown") {
        let Some(tid) = turn["id"].as_str().filter(|tid| covered.contains(*tid)) else { continue };
        for item in turn["items"].as_array().into_iter().flatten() {
            let Some(id) = item["id"].as_str() else { continue };
            if item["type"] == "agentMessage" && item["_yuzunoCompletedText"].is_null() && item["_yuzunoUnsaved"] != true
                && !saved_ids.contains(id) && item["text"].as_str().is_some_and(|t| !t.is_empty()) {
                steps.push(Step::Unsaved { turn: tid.to_owned(), item: id.to_owned() });
            }
        }
    }
    Plan { steps, unmatched: false }
}

/// The record's last turn Yuzuno sent, if it was sent before prompt uuids
/// were kept (its prompt has none), has nothing of Claude's yet, and starts
/// with this prompt's text.
fn unanswered_turn(d: &AgentDetail, e: &Entry, claimed: &HashSet<String>) -> Option<String> {
    let text = e.text.as_deref().filter(|t| !t.trim().is_empty())?;
    let turn = d.turns.iter().rev().find(|t| t["id"].as_str().is_some_and(|id| !claude::native_turn(id)))?;
    let tid = turn["id"].as_str()?;
    let items = turn["items"].as_array()?;
    let unanswered = !items.iter().any(|i| matches!(i["type"].as_str(), Some("agentMessage" | "claudeToolUse" | "reasoning")));
    let prompt = items.iter().find(|i| i["type"] == "userMessage")?;
    let first: String = prompt["content"].as_array()?.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n");
    (unanswered && !claimed.contains(tid) && prompt["nativeUuid"].is_null() && first.starts_with(text)).then(|| tid.to_owned())
}

fn saved_time(message: &Value) -> Option<DateTime<Utc>> {
    message["timestamp"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok()).map(|t| t.with_timezone(&Utc))
}

/// A saved prompt as its conversation item shows it: its text; an image
/// Claude saved is only named (the record keeps no copy of it).
fn prompt_content(message: &Value) -> Value {
    match &message["message"]["content"] {
        Value::String(text) => json!([{"type":"text","text":text}]),
        Value::Array(blocks) => {
            let images = blocks.iter().filter(|b| b["type"] == "image").count();
            let mut content: Vec<Value> = blocks.iter().filter(|b| b["type"] == "text").map(|b| json!({"type":"text","text":b["text"]})).collect();
            if images > 0 {
                content.push(json!({"type":"text","text":format!("[{images} image{} saved by Claude, not shown]", if images == 1 { "" } else { "s" })}));
            }
            Value::Array(content)
        }
        _ => json!([]),
    }
}

/// Facts of an applied backfill, for its journal row (not the messages).
#[derive(Debug, Default, PartialEq)]
pub(crate) struct Applied {
    pub messages: usize,
    /// Streamed text marked as never saved by Claude.
    pub unsaved: usize,
    pub outside_turns: Vec<String>,
    pub turns: Vec<String>,
}

/// Adds the planned saved messages to the record, checking each again: one
/// the record holds by now is skipped, so applying twice adds nothing.
/// `messages`: the saved messages by offset (`history_messages`).
pub(crate) fn apply(d: &mut AgentDetail, plan: &Plan, entries: &[Entry], messages: &HashMap<usize, Value>, now: DateTime<Utc>) -> Applied {
    let mut applied = Applied::default();
    let by_offset: HashMap<usize, &Entry> = entries.iter().map(|e| (e.offset, e)).collect();
    let mut touched: Vec<String> = Vec::new();
    let mut last_stop: HashMap<String, Option<String>> = HashMap::new();
    let mut known = Known::of(d);
    for step in &plan.steps {
        if let Step::Unsaved { turn, item } = step {
            let found = d.turns.iter_mut().find(|t| t["id"] == turn.as_str() && t["status"] == "outcomeUnknown")
                .and_then(|t| t["items"].as_array_mut()?.iter_mut().find(|i| i["id"] == item.as_str()));
            if let Some(item) = found.filter(|i| i["_yuzunoCompletedText"].is_null() && i["_yuzunoUnsaved"] != true) {
                item["_yuzunoUnsaved"] = true.into();
                applied.unsaved += 1;
            }
            continue;
        }
        let Some(offset) = step.offset() else { continue };
        let (Some(entry), Some(message)) = (by_offset.get(&offset), messages.get(&offset)) else { continue };
        let at = saved_time(message).unwrap_or(now);
        if let Some(turn) = touched.last().and_then(|tid| d.turns.iter().find(|t| t["id"] == tid.as_str())) {
            known.add(turn);
        }
        match step {
            // Marked above; it needs no saved message.
            Step::Unsaved { .. } => continue,
            Step::Outside { turn, .. } => {
                if d.turns.iter().any(|t| t["id"] == turn.as_str()) || known.turn_of(entry).is_some() {
                    continue;
                }
                let item_id = format!("{turn}:input");
                let t = d.turn_at(turn, at);
                t["_yuzunoSource"] = "native".into();
                t["_yuzunoOrigin"] = "outside".into();
                let mut item = json!({"id":item_id,"type":"userMessage","content":prompt_content(message),"nativeUuid":entry.uuid});
                crate::conversation_time::stamp_message(&mut item, Some(at.timestamp_millis()), "claude");
                t["items"].as_array_mut().expect("turn items").push(item);
                applied.outside_turns.push(turn.clone());
                touched.push(turn.clone());
            }
            Step::Compaction { turn, .. } => {
                let Some(uuid) = entry.uuid.as_deref() else { continue };
                if known.items.contains_key(uuid) || !d.turns.iter().any(|t| t["id"] == turn.as_str()) {
                    continue;
                }
                let t = d.turn_at(turn, at);
                t["items"].as_array_mut().expect("turn items").push(json!({"id":uuid,"type":"contextCompaction","status":"completed",
                    "_yuzunoSavedAt":at.timestamp_millis()}));
                touched.push(turn.clone());
            }
            Step::Message { turn, .. } => {
                if known.turn_of(entry).is_some() || !d.turns.iter().any(|t| t["id"] == turn.as_str()) {
                    continue;
                }
                let before: HashSet<String> = turn_items(d, turn);
                // Saved messages carry no runtime's session check: the read
                // was of this Agent's session (see the bridge's history_read).
                let mut frame = message.clone();
                if let Some(frame) = frame.as_object_mut() {
                    frame.remove("session_id");
                }
                claude::project_event_at(d, Some(turn.as_str()), &frame, at);
                // What Claude saved was not seen live: its time is Claude's.
                if let Some(t) = d.turns.iter_mut().find(|t| t["id"] == turn.as_str()) {
                    for item in t["items"].as_array_mut().into_iter().flatten() {
                        if item["id"].as_str().is_some_and(|id| !before.contains(id)) {
                            if let Some(time) = item.get_mut(crate::conversation_time::ITEM_TIME) {
                                time["source"] = "claude".into();
                            }
                            item["_yuzunoSaved"] = true.into();
                        }
                    }
                }
                if entry.agent_id.is_none() && entry.kind == "assistant" {
                    last_stop.insert(turn.clone(), entry.stop_reason.clone());
                }
                applied.messages += 1;
                touched.push(turn.clone());
            }
        }
    }
    let mut seen = HashSet::new();
    touched.retain(|t| seen.insert(t.clone()));
    for tid in &touched {
        let Some(t) = d.turns.iter_mut().find(|t| t["id"] == tid.as_str()) else { continue };
        // A turn sent outside Yuzuno: this backfill's, or an earlier one's
        // (whose end a later reconnect may have found saved).
        let outside = t["_yuzunoOrigin"] == "outside";
        // These turns have ended: like a live end, no working copies remain.
        claude::drop_turn_scratch(t);
        // Only a reply Claude saved this time says how the turn ended now;
        // a late tool or sub-agent result alone changes nothing about that.
        let stop = last_stop.get(tid).map(|s| s.as_deref());
        if outside && (stop.is_some() || applied.outside_turns.contains(tid)) {
            // It ended as Claude saved it: its reply finished (end_turn) with
            // no call still open, or what came after is unknown.
            let open = t["items"].as_array().into_iter().flatten().any(|i| i["type"] == "claudeToolUse" && i["status"] == "inProgress");
            if stop == Some(Some("end_turn")) && !open {
                t["status"] = "completed".into();
                t.as_object_mut().map(|t| t.remove("error"));
            } else {
                t["status"] = "outcomeUnknown".into();
                t["error"] = json!({"message":"Claude 保存的历史到此为止；之后是否继续执行未知。"});
            }
        } else if !outside && t["status"] == "outcomeUnknown" {
            t["error"] = json!({"message":"已补回 Claude 保存的内容；连接结束前未收到原生完成结果，之后是否继续执行未知，未保存的部分无法恢复。"});
        }
        // A call filled in without its saved result never reports now.
        if t["status"] == "outcomeUnknown" {
            claude::settle_open_tools(t);
        }
    }
    applied.turns = touched;
    applied
}

fn turn_items(d: &AgentDetail, turn: &str) -> HashSet<String> {
    d.turns.iter().find(|t| t["id"] == turn).and_then(|t| t["items"].as_array())
        .map(|items| items.iter().filter_map(|i| i["id"].as_str().map(str::to_owned)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SESSION: &str = "7f7263b1-4654-49fe-97d9-2da71f7cda47";

    fn detail(turns: Value) -> AgentDetail {
        serde_json::from_value(json!({"agent": {
            "id":"a","name":"Claude","goal":"test","cwd":"/tmp","model":"haiku","color":"sage",
            "harness":"claude","threadId":null,"status":"idle","createdAt":"now","updatedAt":"now",
            "unreadCount":0,"pendingCount":0,"lastMessage":null,"lastSeq":0,"reviewedSeq":0,"error":null,
            "connectionState":"connected","claudeSessionId":SESSION
        },"turns":turns,"pending":[],"artifacts":[]})).unwrap()
    }

    // Saved messages as SDK 0.3.296's getSessionMessages returns them
    // (probes 5c16542a, 54b7e79a): one content block per assistant entry.
    fn prompt(uuid: &str, text: &str) -> Value {
        json!({"type":"user","uuid":uuid,"session_id":SESSION,"parent_tool_use_id":null,"timestamp":"2026-10-17T00:30:00Z",
            "message":{"role":"user","content":[{"type":"text","text":text}]}})
    }
    fn said(uuid: &str, mid: &str, text: &str, stop: &str) -> Value {
        json!({"type":"assistant","uuid":uuid,"session_id":SESSION,"parent_tool_use_id":null,"timestamp":"2026-10-17T00:30:01Z",
            "message":{"id":mid,"role":"assistant","stop_reason":stop,"content":[{"type":"text","text":text}]}})
    }
    fn calls(uuid: &str, mid: &str, tool: &str, parent: Option<&str>) -> Value {
        json!({"type":"assistant","uuid":uuid,"session_id":SESSION,"parent_tool_use_id":parent,"timestamp":"2026-10-17T00:30:02Z",
            "message":{"id":mid,"role":"assistant","stop_reason":"tool_use","content":[{"type":"tool_use","id":tool,"name":"Bash","input":{"command":"ls"}}]}})
    }
    fn answers(uuid: &str, tool: &str, output: &str, error: bool, parent: Option<&str>) -> Value {
        json!({"type":"user","uuid":uuid,"session_id":SESSION,"parent_tool_use_id":parent,"timestamp":"2026-10-17T00:30:03Z",
            "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":tool,"content":output,"is_error":error}]}})
    }
    fn system(uuid: &str) -> Value {
        json!({"type":"system","uuid":uuid,"session_id":SESSION,"parent_tool_use_id":null,"timestamp":"2026-10-17T00:30:04Z"})
    }
    fn flagged(uuid: &str, text: &str, flag: &str) -> Value {
        let mut m = json!({"type":"user","uuid":uuid,"session_id":SESSION,"parent_tool_use_id":null,"timestamp":"2026-10-17T00:30:05Z",
            "message":{"role":"user","content":text}});
        for f in flag.split(',') { m[f] = true.into(); }
        m
    }

    /// The bridge's `historyEntry` for each saved message (main chain, then
    /// sub-agents with their agent id), and the messages by offset.
    fn saved(main: &[Value], sub: &[(&str, Value)]) -> (Vec<Entry>, HashMap<usize, Value>) {
        let all: Vec<(Option<&str>, &Value)> = main.iter().map(|m| (None, m)).chain(sub.iter().map(|(a, m)| (Some(*a), m))).collect();
        let entries = all.iter().enumerate().map(|(offset, (agent, m))| {
            let content = match &m["message"]["content"] {
                Value::String(t) => vec![json!({"type":"text","text":t})],
                Value::Array(b) => b.clone(),
                _ => vec![],
            };
            let prompt = m["type"] == "user" && !content.iter().any(|b| b["type"] == "tool_result");
            serde_json::from_value(json!({"offset":offset,"uuid":m["uuid"],"type":m["type"],"agentId":agent,
                "parentToolUseId":m["parent_tool_use_id"],"timestamp":m["timestamp"],"id":m["message"]["id"],"stopReason":m["message"]["stop_reason"],
                "blocks":content.iter().map(|b| json!({"type":b["type"],"id":b["id"],"toolUseId":b["tool_use_id"]})).collect::<Vec<_>>(),
                "text": if prompt { content.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n").into() } else { Value::Null },
                "flags":{"meta":m["is_meta"] == true,"compactSummary":m["isCompactSummary"] == true,"localCommand":m["isCompletedLocalCommand"] == true,
                    "synthetic":m["message"]["model"] == "<synthetic>"}})).unwrap()
        }).collect();
        (entries, all.iter().enumerate().map(|(i, (_, m))| (i, (*m).clone())).collect())
    }

    fn backfill(d: &mut AgentDetail, main: &[Value], sub: &[(&str, Value)]) -> Applied {
        let (entries, messages) = saved(main, sub);
        let plan = plan(d, &entries);
        assert!(!plan.unmatched);
        apply(d, &plan, &entries, &messages, Utc::now())
    }

    fn turn<'a>(d: &'a AgentDetail, id: &str) -> &'a Value {
        d.turns.iter().find(|t| t["id"] == id).unwrap()
    }
    fn ids(turn: &Value) -> Vec<String> {
        turn["items"].as_array().unwrap().iter().map(|i| i["id"].as_str().unwrap().to_owned()).collect()
    }

    // A Yuzuno turn cut off by a Core restart: Core saw the call and the
    // start of a reply; Claude saved the call's result and the whole reply.
    fn cut() -> AgentDetail {
        detail(json!([{"id":"t1","status":"outcomeUnknown","_claudeAssistantSeen":{"a1":true},"items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"List files"}],"nativeUuid":"t1"},
            {"id":"c1","type":"claudeToolUse","name":"Bash","input":{"command":"ls"},"status":"unknown"},
            {"id":"m2","type":"agentMessage","text":"The fil","nativeMessageId":"m2"}]}]))
    }

    #[test]
    fn output_claude_saved_but_core_never_saw_fills_its_turn_once() {
        let mut d = cut();
        let chain = [prompt("t1", "List files"), calls("a1", "m1", "c1", None), answers("r1", "c1", "a.txt", false, None),
            said("a2", "m2", "The files are a.txt.", "end_turn"), system("s1")];
        let applied = backfill(&mut d, &chain, &[]);
        assert_eq!((applied.messages, applied.outside_turns.len()), (2, 0));
        let t = turn(&d, "t1");
        assert_eq!(ids(t), ["t1:input", "c1", "m2"], "nothing doubled, no prompt or system item added");
        let c1 = &t["items"][1];
        assert_eq!((c1["status"].as_str(), c1["output"].as_str()), (Some("completed"), Some("a.txt")));
        let m2 = &t["items"][2];
        assert_eq!(m2["text"], "The files are a.txt.", "the saved reply replaces what streamed");
        assert!(m2.get("_yuzunoUnsaved").is_none());
        // Claude never confirmed the turn: still unknown, saying what is shown.
        assert_eq!(t["status"], "outcomeUnknown");
        assert!(t["error"]["message"].as_str().unwrap().contains("已补回"));
        // Reconnecting again adds nothing.
        let before = serde_json::to_value(&d.turns).unwrap();
        let (entries, _) = saved(&chain, &[]);
        assert!(plan(&d, &entries).steps.is_empty());
        assert_eq!(backfill(&mut d, &chain, &[]), Applied::default());
        assert_eq!(serde_json::to_value(&d.turns).unwrap(), before);
    }

    #[test]
    fn the_conversation_window_read_from_saved_rows_shows_what_a_backfill_added() {
        use crate::conversation_window::Query;
        use crate::store::Store;
        // On disk next to the build, as the store's own tests are.
        let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
        std::fs::create_dir_all(parent).unwrap();
        let dir = tempfile::tempdir_in(parent).unwrap();
        let path = dir.path().join("workspace.sqlite");
        // Saved rows, through the window index cache (T81), or the held record.
        let read = |store: &Store| {
            let window = store.client_window("a", &Query::default()).unwrap().unwrap();
            let turn = window.detail.turns.iter().find(|t| t["id"] == "t1").unwrap().clone();
            (window.stats.source, window.stats.index_build_items, ids(&turn), turn)
        };
        let store = Store::open(&path).unwrap();
        store.insert(&cut()).unwrap();
        let (source, built, before, _) = read(&store);
        assert_eq!((source, before.as_slice()), ("rows", ["t1:input", "c1", "m2"].map(String::from).as_slice()));
        assert!(built > 0);
        assert_eq!(read(&store).1, 0, "the window index is cached");
        // Through Store::update, as claude_backfill applies it.
        let chain = [prompt("t1", "List files"), calls("a1", "m1", "c1", None), answers("r1", "c1", "a.txt", false, None),
            said("a2", "m2", "The files are a.txt.", "end_turn")];
        let (entries, messages) = saved(&chain, &[]);
        let plan = plan(&store.detail("a").unwrap(), &entries);
        store.update("a", "claude/history", &json!({}), |d| { apply(d, &plan, &entries, &messages, Utc::now()); }).unwrap();
        // An update keeps the record held until other Agents' records take
        // its place; then windows are read from its saved rows again.
        assert_eq!(read(&store).0, "held");
        for i in 0..crate::store::MAX_STREAMS {
            let mut other = detail(json!([]));
            other.agent.id = format!("b{i}");
            store.insert(&other).unwrap();
            store.update(&other.agent.id, "test/touched", &json!({}), |_| {}).unwrap();
        }
        let (source, built, after, turn) = read(&store);
        assert_eq!(source, "rows");
        assert!(built > 0, "the changed items' cached index entries were rebuilt, not served stale");
        assert_eq!(after, before, "nothing doubled");
        assert_eq!((turn["items"][1]["output"].as_str(), turn["items"][2]["text"].as_str()), (Some("a.txt"), Some("The files are a.txt.")));
        // A second backfill finds nothing to add.
        assert!(super::plan(&store.detail("a").unwrap(), &entries).steps.is_empty());
    }

    #[test]
    fn a_reply_claude_never_saved_stays_as_streamed_and_says_so() {
        let mut d = cut();
        // Killed while the reply streamed: Claude saved the call, no result,
        // no reply (probe 1cf443a8), and on resuming its own placeholder.
        let mut placeholder = said("syn", "9bbfe5b5-2820-4dba-9d36-13f247ec6db7", "No response requested.", "stop_sequence");
        placeholder["message"]["model"] = "<synthetic>".into();
        let chain = [prompt("t1", "List files"), calls("a1", "m1", "c1", None), placeholder];
        let applied = backfill(&mut d, &chain, &[]);
        assert_eq!((applied.messages, applied.unsaved), (0, 1), "nothing added, no placeholder shown as a reply");
        let t = turn(&d, "t1");
        assert_eq!(ids(t), ["t1:input", "c1", "m2"]);
        let m2 = &t["items"][2];
        assert_eq!((m2["text"].as_str(), m2["_yuzunoUnsaved"].as_bool()), (Some("The fil"), Some(true)), "what streamed stays, marked unsaved");
        assert_eq!(t["status"], "outcomeUnknown");
        let (entries, _) = saved(&chain, &[]);
        assert!(plan(&d, &entries).steps.is_empty(), "marked once");
        // With the call's result saved: added, and the unsaved text still marked.
        let mut d = cut();
        let applied = backfill(&mut d, &[prompt("t1", "List files"), calls("a1", "m1", "c1", None), answers("r1", "c1", "a.txt", false, None)], &[]);
        assert_eq!((applied.messages, applied.unsaved), (1, 1));
        let m2 = &turn(&d, "t1")["items"][2];
        assert_eq!((m2["text"].as_str(), m2["_yuzunoUnsaved"].as_bool()), (Some("The fil"), Some(true)));
        // A turn that ended (not cut off) is never marked.
        let mut d = cut();
        d.turns[0]["status"] = "completed".into();
        let (entries, _) = saved(&[prompt("t1", "List files"), calls("a1", "m1", "c1", None)], &[]);
        assert!(plan(&d, &entries).steps.is_empty());
    }

    #[test]
    fn a_turn_sent_from_a_terminal_is_its_own_turn_and_a_denial_is_not_a_message() {
        let mut d = detail(json!([{"id":"t1","status":"completed","_claudeAssistantSeen":{"a1":true},"items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"Hi"}],"nativeUuid":"t1"},
            {"id":"m1","type":"agentMessage","text":"Hello","_yuzunoCompletedText":"Hello"}]}]));
        let chain = [prompt("t1", "Hi"), said("a1", "m1", "Hello", "end_turn"), system("s1"),
            prompt("p2", "Run ls"), calls("a2", "m2", "c2", None), answers("r2", "c2", "Permission to use Bash was denied", true, None),
            said("a3", "m3", "I could not run it.", "end_turn"), system("s2")];
        let applied = backfill(&mut d, &chain, &[]);
        assert_eq!(applied.outside_turns, ["native-p2"]);
        assert_eq!(d.turns.len(), 2);
        let t = turn(&d, "native-p2");
        assert_eq!((t["_yuzunoSource"].as_str(), t["_yuzunoOrigin"].as_str(), t["status"].as_str()), (Some("native"), Some("outside"), Some("completed")));
        assert_eq!(ids(t), ["native-p2:input", "c2", "m3"]);
        assert_eq!(t["items"][0]["content"][0]["text"], "Run ls");
        assert_eq!(t["items"][0]["_yuzunoTime"]["source"], "claude");
        let c2 = &t["items"][1];
        assert_eq!((c2["status"].as_str(), c2["output"].as_str()), (Some("failed"), Some("Permission to use Bash was denied")));
        assert_eq!(t["items"].as_array().unwrap().iter().filter(|i| i["type"] == "userMessage").count(), 1);
        assert_eq!(t["items"][2]["_yuzunoTime"]["source"], "claude");
        assert_eq!(d.agent.last_message.as_deref(), Some("I could not run it."));
        let (entries, _) = saved(&chain, &[]);
        assert!(plan(&d, &entries).steps.is_empty(), "a second reconnect adds nothing");
        // A terminal turn whose saved messages stop at a call: unknown, its call too.
        let mut d = detail(json!([{"id":"t1","status":"completed","_claudeAssistantSeen":{"a1":true},"items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"Hi"}],"nativeUuid":"t1"},
            {"id":"m1","type":"agentMessage","text":"Hello","_yuzunoCompletedText":"Hello"}]}]));
        backfill(&mut d, &[prompt("t1", "Hi"), said("a1", "m1", "Hello", "end_turn"), prompt("p2", "Run ls"), calls("a2", "m2", "c2", None)], &[]);
        let t = turn(&d, "native-p2");
        assert_eq!((t["status"].as_str(), t["items"][1]["status"].as_str()), (Some("outcomeUnknown"), Some("unknown")));
    }

    #[test]
    fn history_before_the_record_is_not_imported_and_a_foreign_chain_changes_nothing() {
        let record = || detail(json!([{"id":"t1","status":"completed","_claudeAssistantSeen":{"a1":true},"items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"Hi"}],"nativeUuid":"t1"},
            {"id":"m1","type":"agentMessage","text":"Hello","_yuzunoCompletedText":"Hello"}]}]));
        let mut d = record();
        let applied = backfill(&mut d, &[prompt("p0", "Earlier, elsewhere"), said("a0", "m0", "Old", "end_turn"),
            prompt("t1", "Hi"), said("a1", "m1", "Hello", "end_turn")], &[]);
        assert_eq!(applied, Applied::default());
        let (entries, _) = saved(&[prompt("x", "Another session"), said("y", "my", "?", "end_turn")], &[]);
        assert_eq!(plan(&record(), &entries), Plan { steps: vec![], unmatched: true });
        // Compacted in a terminal: what follows the summary is new.
        let mut d = record();
        let applied = backfill(&mut d, &[system("b"), flagged("c", "This session is being continued from a previous conversation.", "isCompactSummary,is_meta"),
            flagged("l", "<command-name>/compact</command-name>", "isCompletedLocalCommand"), prompt("p3", "Go on"), said("a3", "m3", "On it.", "end_turn")], &[]);
        assert_eq!(applied.outside_turns, ["native-p3"]);
        assert_eq!(ids(turn(&d, "t1")), ["t1:input", "m1", "c"], "the compaction is marked where it happened");
        assert_eq!(turn(&d, "t1")["items"][2]["type"], "contextCompaction");
        assert_eq!(ids(turn(&d, "native-p3")), ["native-p3:input", "m3"], "no summary or local command as a message");
    }

    #[test]
    fn an_import_takes_the_whole_session_and_a_later_resume_adds_only_what_is_new() {
        let mut d = detail(json!([]));
        let chain = vec![system("s0"), prompt("p1", "Hi"), said("a1", "m1", "Hello", "end_turn"),
            prompt("p2", "Run ls"), calls("a2", "m2", "c2", None), answers("r2", "c2", "a.txt", false, None),
            said("a3", "m3", "There is a.txt.", "end_turn"), system("s1")];
        let (entries, messages) = saved(&chain, &[]);
        assert_eq!(plan(&d, &entries).unmatched, true, "a backfill never takes a session the record does not hold");
        let import = plan_import(&d, &entries);
        assert_eq!(import_gaps(&entries, &import), (0, false));
        let applied = apply(&mut d, &import, &entries, &messages, Utc::now());
        assert_eq!(applied.outside_turns, ["native-p1", "native-p2"]);
        assert_eq!(ids(turn(&d, "native-p1")), ["native-p1:input", "m1"]);
        assert_eq!(ids(turn(&d, "native-p2")), ["native-p2:input", "c2", "m3"]);
        for t in &d.turns {
            assert_eq!((t["status"].as_str(), t["_yuzunoOrigin"].as_str()), (Some("completed"), Some("outside")));
        }
        assert_eq!(d.agent.last_message.as_deref(), Some("There is a.txt."));
        // Resumed later: the same saved messages are this record's, so a
        // backfill adds nothing and no saved prompt becomes a turn again.
        let before = serde_json::to_value(&d.turns).unwrap();
        assert_eq!(plan(&d, &entries), Plan { steps: vec![], unmatched: false });
        assert_eq!(serde_json::to_value(&d.turns).unwrap(), before);
        // A prompt sent after the import (in a terminal, say) is the only new turn.
        let mut longer = chain.clone();
        longer.extend([prompt("p3", "Thanks"), said("a4", "m4", "Any time.", "end_turn")]);
        let applied = backfill(&mut d, &longer, &[]);
        assert_eq!((applied.outside_turns.as_slice(), applied.messages), (["native-p3".to_owned()].as_slice(), 1));
        assert_eq!(d.turns.len(), 3);
        assert_eq!(ids(turn(&d, "native-p2")), ["native-p2:input", "c2", "m3"], "nothing doubled");
    }

    #[test]
    fn an_import_says_what_the_saved_chain_does_not_hold() {
        // Compacted: the chain starts at its summary, so earlier messages are
        // not there; output before any prompt has no turn to go in.
        let chain = [flagged("c", "This session is being continued from a previous conversation.", "isCompactSummary,is_meta"),
            said("a0", "m0", "Picking up.", "end_turn"), prompt("p1", "Go on"), said("a1", "m1", "On it.", "end_turn")];
        let (entries, messages) = saved(&chain, &[]);
        let mut d = detail(json!([]));
        let import = plan_import(&d, &entries);
        assert_eq!(import_gaps(&entries, &import), (1, true));
        apply(&mut d, &import, &entries, &messages, Utc::now());
        assert_eq!(d.turns.len(), 1);
        assert_eq!(ids(turn(&d, "native-p1")), ["native-p1:input", "m1"], "no summary shown as a prompt");
        // Nothing saved but system messages: nothing to show, nothing invented.
        let (entries, _) = saved(&[system("s0")], &[]);
        let import = plan_import(&detail(json!([])), &entries);
        assert!(import.steps.is_empty());
        assert_eq!(import_gaps(&entries, &import), (0, false));
    }

    #[test]
    fn prompts_sent_before_uuids_were_kept_are_recognized_by_their_reply_or_text() {
        // Its reply is in the record: the prompt is that turn's.
        let mut d = detail(json!([{"id":"old","status":"completed","_claudeAssistantSeen":{"a1":true},"items":[
            {"id":"old:input","type":"userMessage","content":[{"type":"text","text":"Hi"}]},
            {"id":"m1","type":"agentMessage","text":"Hello","_yuzunoCompletedText":"Hello"}]}]));
        assert_eq!(backfill(&mut d, &[prompt("random", "Hi"), said("a1", "m1", "Hello", "end_turn")], &[]), Applied::default());
        // Its reply never reached the record: the same text, in Yuzuno's last turn.
        let mut d = detail(json!([
            {"id":"t1","status":"completed","_claudeAssistantSeen":{"a1":true},"items":[
                {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"Hi"}]},
                {"id":"m1","type":"agentMessage","text":"Hello","_yuzunoCompletedText":"Hello"}]},
            {"id":"t2","status":"outcomeUnknown","items":[{"id":"t2:input","type":"userMessage","content":[{"type":"text","text":"Read a.txt"}]}]}]));
        let applied = backfill(&mut d, &[prompt("r1", "Hi"), said("a1", "m1", "Hello", "end_turn"), prompt("r2", "Read a.txt"),
            said("a2", "m2", "alpha", "end_turn")], &[]);
        assert!(applied.outside_turns.is_empty());
        assert_eq!(ids(turn(&d, "t2")), ["t2:input", "m2"]);
    }

    #[test]
    fn a_sub_agents_saved_calls_go_under_its_agent_call_and_meta_never_becomes_a_message() {
        let mut d = detail(json!([{"id":"t1","status":"outcomeUnknown","items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"Delegate"}],"nativeUuid":"t1"},
            {"id":"agent-1","type":"claudeToolUse","name":"Agent","input":{"description":"Read b"},"status":"unknown"}]}]));
        let chain = [prompt("t1", "Delegate"), flagged("meta", "<system-reminder>x</system-reminder>", "is_meta")];
        let sub = [("ag", calls("s1", "ms", "sub-read", Some("agent-1"))), ("ag", answers("s2", "sub-read", "bravo", false, Some("agent-1"))),
            ("ag", said("s3", "ms2", "b is bravo", "end_turn")), ("other", calls("s4", "mo", "lost", Some("never-seen")))];
        backfill(&mut d, &chain, &sub);
        let t = turn(&d, "t1");
        assert_eq!(ids(t), ["t1:input", "agent-1", "sub-read"], "its text is not the conversation, an unknown call's calls stay out");
        assert_eq!((t["items"][2]["parentToolUseId"].as_str(), t["items"][2]["output"].as_str()), (Some("agent-1"), Some("bravo")));
        let (entries, _) = saved(&chain, &sub);
        assert!(plan(&d, &entries).steps.is_empty());
    }

    fn thinks(uuid: &str, mid: &str, text: &str) -> Value {
        json!({"type":"assistant","uuid":uuid,"session_id":SESSION,"parent_tool_use_id":null,"timestamp":"2026-10-17T00:30:01Z",
            "message":{"id":mid,"role":"assistant","stop_reason":"end_turn","content":[{"type":"thinking","thinking":text,"signature":"s"}]}})
    }

    // Review 095da2c6, P2: one message's text blocks are separate saved messages.
    #[test]
    fn every_saved_text_block_of_one_message_is_kept() {
        // Core saw the message's first text block live; Claude saved a second.
        let mut d = detail(json!([{"id":"t1","status":"outcomeUnknown","_claudeAssistantSeen":{"a1":true},
            "_claudeTextBlocks":{"m1":[{"index":"0","text":"First. ","confirmed":true}]},"items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"Go"}],"nativeUuid":"t1"},
            {"id":"m1","type":"agentMessage","text":"First. ","_yuzunoCompletedText":"First. ","nativeMessageId":"m1"}]}]));
        let chain = [prompt("t1", "Go"), said("a1", "m1", "First. ", "end_turn"), said("a2", "m1", "Second.", "end_turn")];
        assert_eq!(backfill(&mut d, &chain, &[]).messages, 1);
        assert_eq!(turn(&d, "t1")["items"][1]["text"], "First. Second.");
        let (entries, _) = saved(&chain, &[]);
        assert!(plan(&d, &entries).steps.is_empty(), "a later reconnect keeps both, once");
        // Neither seen: both are filled in.
        let mut d = detail(json!([{"id":"t1","status":"outcomeUnknown","items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"Go"}],"nativeUuid":"t1"}]}]));
        assert_eq!(backfill(&mut d, &chain, &[]).messages, 2);
        assert_eq!(turn(&d, "t1")["items"][1]["text"], "First. Second.");
        assert!(plan(&d, &entries).steps.is_empty());
    }

    // Review 095da2c6, P2: a reasoning item may hold only the start that streamed.
    #[test]
    fn saved_thinking_replaces_what_streamed_of_it_in_a_cut_off_turn() {
        let record = |status: &str| detail(json!([{"id":"t1","status":status,"items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"Go"}],"nativeUuid":"t1"},
            {"id":"m1:thinking","type":"reasoning","summary":["I am thi"],"nativeMessageId":"m1"}]}]));
        let chain = [prompt("t1", "Go"), thinks("th1", "m1", "I am thinking hard.")];
        let mut d = record("outcomeUnknown");
        assert_eq!(backfill(&mut d, &chain, &[]).messages, 1);
        assert_eq!(turn(&d, "t1")["items"][1]["summary"], json!(["I am thinking hard."]));
        assert_eq!(ids(turn(&d, "t1")), ["t1:input", "m1:thinking"]);
        let (entries, _) = saved(&chain, &[]);
        assert!(plan(&d, &entries).steps.is_empty(), "its frame is known now");
        // A turn that ended had its thinking complete: nothing to replace.
        assert!(plan(&record("completed"), &entries).steps.is_empty());
    }

    // Review 095da2c6, P2: a call filled in without its result never reports.
    #[test]
    fn a_call_filled_into_a_cut_off_turn_without_its_result_is_unknown() {
        let mut d = cut();
        backfill(&mut d, &[prompt("t1", "List files"), calls("a1", "m1", "c1", None), answers("r1", "c1", "a.txt", false, None),
            calls("a4", "m4", "c2", None)], &[]);
        let t = turn(&d, "t1");
        assert_eq!(ids(t), ["t1:input", "c1", "m2", "c2"]);
        assert_eq!((t["items"][3]["status"].as_str(), t["status"].as_str()), (Some("unknown"), Some("outcomeUnknown")));
    }

    // Review 095da2c6, P2: a turn sent outside Yuzuno whose end a later reconnect finds saved.
    #[test]
    fn a_turn_from_outside_found_incomplete_completes_when_its_end_is_saved() {
        let mut d = detail(json!([{"id":"t1","status":"completed","_claudeAssistantSeen":{"a1":true},"items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"Hi"}],"nativeUuid":"t1"},
            {"id":"m1","type":"agentMessage","text":"Hello","_yuzunoCompletedText":"Hello"}]}]));
        let start = vec![prompt("t1", "Hi"), said("a1", "m1", "Hello", "end_turn"), prompt("p2", "Run ls"), calls("a2", "m2", "c2", None)];
        backfill(&mut d, &start, &[]);
        let t = turn(&d, "native-p2");
        assert_eq!((t["status"].as_str(), t["items"][1]["status"].as_str()), (Some("outcomeUnknown"), Some("unknown")));
        // A later reconnect: Claude has saved the rest of that turn.
        let mut rest = start.clone();
        rest.extend([answers("r2", "c2", "a.txt", false, None), said("a3", "m3", "Done.", "end_turn")]);
        let applied = backfill(&mut d, &rest, &[]);
        assert_eq!((applied.messages, applied.outside_turns.len()), (2, 0));
        let t = turn(&d, "native-p2");
        assert_eq!((t["status"].as_str(), t.get("error").is_some()), (Some("completed"), false));
        assert_eq!((t["items"][1]["status"].as_str(), t["items"][1]["output"].as_str()), (Some("completed"), Some("a.txt")));
        assert_eq!(ids(t), ["native-p2:input", "c2", "m3"]);
        // A late result alone (no reply saved this time) changes nothing about how it ended.
        let mut late = rest.clone();
        late.push(json!({"type":"user","uuid":"r9","session_id":SESSION,"parent_tool_use_id":"c2","timestamp":"2026-10-17T00:30:09Z",
            "message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"never","content":"x","is_error":false}]}}));
        backfill(&mut d, &late, &[]);
        assert_eq!(turn(&d, "native-p2")["status"], "completed");
    }

    // Review 76f3ce50, P2: a call that started streaming is not the call Claude saved.
    #[test]
    fn a_saved_call_replaces_the_placeholder_its_stream_started() {
        // Core lost the connection while the call's arguments streamed: its
        // content_block_start left a name and `{}`, nothing more.
        let mut d = detail(json!([{"id":"t1","status":"outcomeUnknown","items":[
            {"id":"t1:input","type":"userMessage","content":[{"type":"text","text":"List files"}],"nativeUuid":"t1"},
            {"id":"c1","type":"claudeToolUse","name":"Bash","input":{},"status":"unknown"}]}]));
        let chain = [prompt("t1", "List files"), calls("a1", "m1", "c1", None)];
        assert_eq!(backfill(&mut d, &chain, &[]).messages, 1);
        let c1 = &turn(&d, "t1")["items"][1];
        assert_eq!((c1["input"].clone(), c1["nativeMessageId"].as_str()), (json!({"command":"ls"}), Some("m1")));
        assert_eq!(ids(turn(&d, "t1")), ["t1:input", "c1"]);
        let (entries, _) = saved(&chain, &[]);
        assert!(plan(&d, &entries).steps.is_empty());
    }

    // Review 76f3ce50, P2: a prompt recognized by its reply takes what it lacks too.
    #[test]
    fn what_a_turn_sent_before_uuids_were_kept_lacks_is_filled_into_that_turn() {
        // The earlier turn is known; the cut-off one was sent before prompt
        // uuids were kept, and its call is known but not its thinking.
        let mut d = detail(json!([
            {"id":"t0","status":"completed","_claudeAssistantSeen":{"a0":true},"items":[
                {"id":"t0:input","type":"userMessage","content":[{"type":"text","text":"Hi"}],"nativeUuid":"t0"},
                {"id":"m0","type":"agentMessage","text":"Hello","_yuzunoCompletedText":"Hello"}]},
            {"id":"old","status":"outcomeUnknown","items":[
                {"id":"old:input","type":"userMessage","content":[{"type":"text","text":"Do it"}]},
                {"id":"c1","type":"claudeToolUse","name":"Bash","input":{"command":"ls"},"nativeMessageId":"m1","status":"unknown"}]}]));
        backfill(&mut d, &[prompt("t0", "Hi"), said("a0", "m0", "Hello", "end_turn"), prompt("random", "Do it"),
            thinks("th1", "m1", "Listing first."), calls("a1", "m1", "c1", None)], &[]);
        assert_eq!(ids(turn(&d, "t0")), ["t0:input", "m0"], "the earlier turn is untouched");
        assert_eq!(ids(turn(&d, "old")), ["old:input", "c1", "m1:thinking"]);
        assert_eq!(d.turns.len(), 2, "no turn of its own for a prompt Yuzuno sent");
    }

    #[test]
    fn a_follow_ups_uuid_comes_from_its_client_id() {
        let a = follow_up_uuid("client-1");
        assert_eq!(a, follow_up_uuid("client-1"));
        assert_ne!(a, follow_up_uuid("client-2"));
        assert!(uuid::Uuid::parse_str(&a).is_ok());
        let d = detail(json!([{"id":"t1","status":"completed","items":[{"id":"t1:client-1","type":"userMessage","clientId":"client-1","content":[]}]}]));
        assert_eq!(Known::of(&d).prompts.get(&a).map(String::as_str), Some("t1"));
    }
}
