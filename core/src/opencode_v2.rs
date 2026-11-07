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
use std::collections::{HashMap, HashSet};

/// What compaction, rewind and fork say on a session whose messages are
/// 2.x's (Lead 4983, decision A): each still reads 1.19.3's, until its own
/// slice moves it. An empty session says nothing of its shape, and holds
/// nothing to rewind or fork.
pub(crate) const NOT_YET: &str = "这在 OpenCode 2.x 上还不能用（not yet on OpenCode 2.x）：Yuzuno 还读不懂 2.x 这一部分的消息";

/// The name Core's record gives a 2.x execution that failed (`halted`).
pub(crate) const EXECUTION_FAILED: &str = "ExecutionFailed";
const ABORTED: &str = "MessageAbortedError";
/// How a turn ends whose run OpenCode stopped because Core rejected one of
/// its permission requests or declined its form (T-61 slice 2, D-7 (a)).
pub(crate) const DECLINED: &str = "这一轮已结束：它的一个请求在 Yuzuno 里被拒绝（declined in Yuzuno: a request of this turn was refused）";

/// Whether a session's messages, as `/api/session/:id/message` pages them,
/// are 2.x's (`{id, type, …}`) rather than 1.19.3's (`{info, parts}`).
pub fn is_v2(messages: &Value) -> bool {
    messages.as_array().is_some_and(|all| all.iter().any(|m| m.get("info").is_none() && m["type"].is_string()))
}

/// The forms Yuzuno fills (T-61 slice 2, D-8 (a)), by the rule 2.x's own
/// ACP client keeps (2.2.5 cli/src/acp/elicitation.ts): a question's or a
/// web search provider's, none of whose fields is external, conditional,
/// hidden and required with no default, or named as a secret, and, as
/// Yuzuno's card shows choices and text only, each a text or multiselect
/// field. Of any other, why: it can only be declined here.
fn unfillable(form: &Value) -> Option<&'static str> {
    const SECRET: [&str; 6] = ["password", "passphrase", "secret", "token", "credential", "private"];
    let secret = |text: &str| {
        let text = text.to_lowercase();
        let squeezed: String = text.chars().filter(|c| !matches!(c, '_' | '-' | ' ')).collect();
        SECRET.iter().any(|word| text.contains(word)) || squeezed.contains("apikey") || squeezed.contains("privatekey")
    };
    if !matches!(form["metadata"]["kind"].as_str(), Some("question" | "websearch.provider")) {
        return Some("not a question Yuzuno asks for OpenCode");
    }
    let fields = form["fields"].as_array().map(Vec::as_slice).unwrap_or_default();
    for field in fields {
        let labels = field["options"].as_array().into_iter().flatten().filter_map(|o| o["label"].as_str());
        if [&field["key"], &field["title"], &field["description"]].into_iter().filter_map(Value::as_str).chain(labels).any(secret) {
            return Some("it asks for a secret");
        }
        match field["type"].as_str() {
            Some("string" | "multiselect") => {}
            Some("external") => return Some("it asks for something done outside OpenCode"),
            _ => return Some("it asks for a kind of answer Yuzuno's card doesn't take"),
        }
        if field["when"].as_array().is_some_and(|when| !when.is_empty()) {
            return Some("its questions depend on each other");
        }
        if field["hidden"] == true && field["required"] == true && field.get("default").is_none() {
            return Some("it needs an answer it doesn't show");
        }
    }
    None
}

/// A 2.x request as Core keeps it (T-61 slice 2): a permission request as 2.x
/// sent it; a form with Core's `questions` read from its shown fields (each
/// one question: its description, else its title, else its key; its title
/// as the header; its options' labels; `multiple` for a multiselect; typed
/// text unless `custom` is false), or, one Yuzuno can't fill, with why
/// (`_opencodeUnfillable`). One function for a form asked live and one a
/// whole read lists.
pub fn request_of(request: &Value) -> Value {
    let mut kept = request.clone();
    let Some(fields) = request["fields"].as_array() else { return kept };
    if let Some(why) = unfillable(request) {
        kept["_opencodeUnfillable"] = why.into();
        return kept;
    }
    let questions: Vec<Value> = fields.iter().filter(|f| f["hidden"] != true).map(|f| {
        let question = f["description"].as_str().or(f["title"].as_str()).or(f["key"].as_str()).unwrap_or_default();
        let options: Vec<Value> = f["options"].as_array().into_iter().flatten()
            .map(|o| json!({"label": o["label"], "description": o["description"]})).collect();
        json!({"question": question, "header": f["title"].as_str().unwrap_or_default(), "options": options,
            "multiple": f["type"] == "multiselect", "custom": f["custom"] != false})
    }).collect();
    kept["questions"] = questions.into();
    kept
}

/// Core's answers to a form (one list per shown question, in its fields'
/// order: the labels chosen or the text typed) as 2.x takes them, by each
/// field's key (T-61 slice 2): a label is its option's value; typed text only
/// where the field takes it; one value for a text field, a list for a
/// multiselect; an empty list leaves the field unanswered; a hidden field
/// takes its default, as 2.x's own clients send it (app `providerFormDefaults`).
pub fn form_answer(form: &Value, answers: &[Vec<String>]) -> anyhow::Result<Value> {
    use anyhow::{bail, ensure};
    ensure!(form.get("_opencodeUnfillable").is_none(), "Yuzuno can't fill this form; it can only be declined");
    let fields = form["fields"].as_array().map(Vec::as_slice).unwrap_or_default();
    let shown: Vec<&Value> = fields.iter().filter(|f| f["hidden"] != true).collect();
    ensure!(answers.len() == shown.len(), "the form has {} questions, {} answered", shown.len(), answers.len());
    let mut answer = serde_json::Map::new();
    for field in fields.iter().filter(|f| f["hidden"] == true) {
        if let (Some(key), Some(default)) = (field["key"].as_str(), field.get("default")) {
            answer.insert(key.to_owned(), default.clone());
        }
    }
    for (field, chosen) in shown.into_iter().zip(answers) {
        let key = field["key"].as_str().unwrap_or_default();
        let value = |text: &str| -> anyhow::Result<Value> {
            let option = field["options"].as_array().into_iter().flatten().find(|o| o["label"] == text);
            match option {
                Some(option) => Ok(option["value"].clone()),
                None if field["custom"] != false => Ok(text.into()),
                None => bail!("{text:?} is not one of the choices of {key}"),
            }
        };
        match (field["type"].as_str(), chosen.as_slice()) {
            (_, []) => {}
            (Some("string"), [one]) => { answer.insert(key.to_owned(), value(one)?); }
            (Some("string"), _) => bail!("{key} takes one answer"),
            (Some("multiselect"), many) => { answer.insert(key.to_owned(), many.iter().map(|t| value(t)).collect::<anyhow::Result<Vec<_>>>()?.into()); }
            _ => bail!("Yuzuno can't answer {key}"),
        }
    }
    Ok(answer.into())
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

/// Marks a user message Core's record takes from a synthetic one that is a
/// sub-agent's result, which 2.x hands the session later in a run of its own
/// (T-61 slice 3, D-15 (a)): never a command's input.
pub const SUB_AGENTS_RESULT: &str = "_opencodeSubAgentsResult";

/// Whether an inbox item is a sub-agent's result (2.2.5 core/src/session/subagent-completion.ts).
fn sub_agents_result(item: &Value) -> bool {
    item["type"] == "synthetic" && item["payload"]["metadata"]["source"] == "subagent"
}

/// A user's or a synthetic message as Core's record takes one.
fn user(id: &str, created: &Value) -> Value {
    json!({"id": id, "role": "user", "time": {"created": created}})
}

/// An answer as Core's record takes one: the user message it answers, when
/// it started and ended, how, with what model and tokens.
#[allow(clippy::too_many_arguments)]
fn answer(id: &str, parent: Option<&str>, created: &Value, completed: &Value, finish: &Value, error: &Value, tokens: &Value,
    model: &Value) -> Value {
    json!({"id": id, "role": "assistant", "parentID": parent, "time": {"created": created, "completed": completed},
        "finish": finish, "error": error, "tokens": tokens, "providerID": model["providerID"], "modelID": model["id"]})
}

/// A compaction, as Core's record took one from 1.19.3: an answer marked as
/// the summary, answering nothing of a turn.
fn compacted(id: &str, at: &Value) -> Value {
    json!({"id": id, "role": "assistant", "summary": true, "parentID": null, "time": {"created": at, "completed": at}})
}

/// A message ID 2.x makes of an event's (`SessionMessage.ID.fromEvent`).
fn from_event(id: &str) -> String {
    id.strip_prefix("evt_").map_or_else(|| id.to_owned(), |rest| format!("msg_{rest}"))
}

/// A shell command's message as Core's record takes one (T-32 slice 4a,
/// D2): the newest user message before it in its turn, which no answer is.
fn shell_info(id: &str, parent: Option<&str>, created: &Value) -> Value {
    json!({"id": id, "role": "shell", "parentID": parent, "time": {"created": created}})
}

/// A shell command as Core's part: its command, how it ended and what it
/// printed (schema/src/shell.ts: running, exited, timeout or killed).
fn shell_part(id: &str, shell: &Value, output: &Value) -> Value {
    let status = match (shell["status"].as_str(), shell["exit"].as_f64()) {
        (Some("running"), _) => "inProgress",
        (Some("exited"), exit) if exit.is_none_or(|exit| exit == 0.0) => "completed",
        _ => "failed",
    };
    json!({"id": id, "messageID": id, "type": "shell", "command": shell["command"], "status": status, "output": output, "exit": shell["exit"]})
}

/// Text gathered for an entry, written as one `message.part.delta` under
/// `event`'s ID: each write is one journal row.
fn written(event: &Value, session: &Value, id: &str, gathered: Gathered) -> Value {
    json!({"id": event["id"], "type": "message.part.delta", "data": {"sessionID": session, "messageID": gathered.message, "partID": id,
        "type": gathered.kind, "delta": gathered.text}})
}

/// A turn's end, read from its `idle` message: the user message it was the
/// turn of, and the error it ended with, if it did not succeed.
#[derive(Debug, PartialEq)]
pub struct Ended {
    pub user: String,
    pub error: Option<Value>,
}

/// An answer under way at a whole read, with what its step's start said,
/// which its end's event does not repeat.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenStep {
    pub id: String,
    /// The user message it answers.
    pub parent: Option<String>,
    pub created: Value,
    pub model: Value,
}

/// A tool under way at a whole read (its input streaming, or running), with
/// its answer, name and input, which its later events do not repeat.
#[derive(Clone, Debug, PartialEq)]
pub struct OpenTool {
    pub id: String,
    pub message: String,
    pub name: Value,
    /// Null while its input still streams.
    pub input: Value,
}

/// A session's stored messages, oldest first, as Core reads them.
pub struct Read {
    /// Each as `{info, parts}`, an answer naming the user message it answers.
    pub messages: Vec<Value>,
    /// Each turn's end that says how it ended.
    pub ended: Vec<Ended>,
    /// The newest user message of a turn not yet ended, which the live
    /// stream goes on from (`Cursor::resumed`).
    pub open: Option<String>,
    /// That turn's answers not yet ended: their ends, after this read, are
    /// theirs, with the model and start this read found (R1 98de4ffb).
    pub steps: Vec<OpenStep>,
    /// Their tools not yet ended: their later events name neither the tool
    /// nor its input.
    pub tools: Vec<OpenTool>,
    /// A compaction still running: its message's ID, which its end, after
    /// this read, is under (R3 4051b7d4).
    pub compaction: Option<String>,
    /// Each shell command still running, by its shell's ID: its message's,
    /// the command item its end, after this read, ends (R4 1dfc453d).
    pub shells: Vec<(String, String)>,
}

pub fn read_messages(messages: &Value) -> Read {
    let (mut read, mut ended, mut steps, mut tools) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut user, mut compaction): (Option<String>, Option<String>) = (None, None);
    let mut shells = Vec::new();
    for message in messages.as_array().into_iter().flatten() {
        let Some(id) = message["id"].as_str() else { continue };
        match message["type"].as_str() {
            Some("user" | "synthetic") => {
                user = Some(id.to_owned());
                let mut info = self::user(id, &message["time"]["created"]);
                // 2.x keeps a synthetic message's metadata as its inbox item had it (core/src/session/message-updater.ts).
                if message["type"] == "synthetic" && message["metadata"]["source"] == "subagent" {
                    info[SUB_AGENTS_RESULT] = true.into();
                }
                read.push(json!({"info": info, "parts": []}));
            }
            Some("assistant") => {
                let failed = if message["error"].is_object() { error(&message["error"], None) } else { Value::Null };
                let info = answer(id, user.as_deref(), &message["time"]["created"], &message["time"]["completed"], &message["finish"],
                    &failed, &message["tokens"], &message["model"]);
                let parts: Vec<Value> = message["content"].as_array().into_iter().flatten().enumerate()
                    .filter_map(|(ordinal, entry)| content_part(id, ordinal, entry)).collect();
                if message["time"]["completed"].is_null() && message["error"].is_null() {
                    steps.push(OpenStep { id: id.to_owned(), parent: user.clone(), created: message["time"]["created"].clone(),
                        model: message["model"].clone() });
                    for entry in message["content"].as_array().into_iter().flatten().filter(|e| e["type"] == "tool"
                        && matches!(e["state"]["status"].as_str(), Some("streaming" | "running"))) {
                        let Some(tool) = entry["id"].as_str() else { continue };
                        let input = &entry["state"]["input"];
                        tools.push(OpenTool { id: tool.to_owned(), message: id.to_owned(), name: entry["name"].clone(),
                            input: if input.is_object() { input.clone() } else { Value::Null } });
                    }
                }
                read.push(json!({"info": info, "parts": parts}));
            }
            Some("shell") => {
                if let Some(shell) = message["shellID"].as_str().filter(|_| message["status"] == "running") {
                    shells.push((shell.to_owned(), id.to_owned()));
                }
                read.push(json!({"info": shell_info(id, user.as_deref(), &message["time"]["created"]),
                    "parts": [shell_part(id, message, &message["output"]["output"])]}));
            }
            // A compaction, running or completed: what was measured before it no longer holds (`measure`).
            Some("compaction") => {
                compaction = (message["status"] == "running").then(|| id.to_owned());
                if message["status"] != "failed" {
                    read.push(json!({"info": compacted(id, &message["time"]["created"]), "parts": []}));
                }
            }
            Some("idle") => {
                steps.clear();
                tools.clear();
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
    Read { messages: read, ended, open: user, steps, tools, compaction, shells }
}

/// What 2.x admitted into a session and has not delivered into its turn
/// yet, as its inbox lists it (`GET /api/session/:id/inbox`, oldest first):
/// each user's message as Core's record takes one. Admitted is durably
/// stored, which is what 1.19.3's stored user message said: it confirms the
/// message was delivered to OpenCode. It answers nothing yet: its answers
/// come once 2.x takes it into the turn (`session.inbox.delivered`).
pub fn admitted(inbox: &Value) -> Vec<Value> {
    inbox.as_array().into_iter().flatten().filter(|item| item["type"] == "user")
        .filter_map(|item| Some(user(item["id"].as_str()?, &item["time"]["created"]))).collect()
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

/// What reading one connection's live events keeps between them, for each
/// session apart (the Agent's and its sub-agents'): a sub-agent's turn
/// ending is not the Agent's.
#[derive(Default)]
pub struct Cursor {
    sessions: HashMap<String, Open>,
}

impl Cursor {
    /// The events of Core's shape one 2.x event stands for, in order (`Open::read`).
    pub fn read(&mut self, event: &Value) -> Vec<Value> {
        let d = &event["data"];
        let session = d["sessionID"].as_str().or(d["form"]["sessionID"].as_str()).unwrap_or_default();
        let open = self.sessions.entry(session.to_owned()).or_default();
        let read = open.read(event);
        // What a session keeps lives only while something of it is under way (T-32 slice 4a, R3 notes).
        if open.is_empty() {
            self.sessions.remove(session);
        }
        read
    }

    /// After a whole read of `session` (`read`, and the `inbox` it listed):
    /// what its live stream goes on from is the turn that read found open, if
    /// any, its answers and tools under way, and what the inbox holds; nothing
    /// else of before it is kept. Text that streamed and was not yet written
    /// is not: an entry's end writes it whole.
    pub fn resumed(&mut self, session: &str, read: &Read, inbox: &Value) {
        let steps = read.steps.iter().map(|s| (s.id.clone(), Step { parent: s.parent.clone(), created: s.created.clone(), model: s.model.clone() }))
            .collect();
        let tools = read.tools.iter().map(|t| (t.id.clone(), Tool { message: t.message.clone(), name: t.name.clone(), input: t.input.clone() }))
            .collect();
        let inputs = inbox.as_array().into_iter().flatten()
            .filter_map(|item| Some((item["id"].as_str()?.to_owned(), item["type"].as_str()?.to_owned()))).collect();
        let results = inbox.as_array().into_iter().flatten().filter(|item| sub_agents_result(item))
            .filter_map(|item| item["id"].as_str().map(str::to_owned)).collect();
        self.sessions.insert(session.to_owned(), Open { user: read.open.clone(), inputs, steps, tools, compaction: read.compaction.clone(),
            shells: read.shells.iter().cloned().collect(), results, ..Open::default() });
    }

    /// A request a whole read found pending (after `resumed`): it ends with
    /// its run, as one asked live does.
    pub fn asked(&mut self, request: &Value) {
        let Some(session) = request["sessionID"].as_str() else { return };
        let replied = if request["fields"].is_array() { "question.replied" } else { "permission.replied" };
        let open = self.sessions.entry(session.to_owned()).or_default();
        open.asked(request["id"].as_str(), replied);
        open.question(request);
    }

    /// Core is about to reject a permission request of `session`'s run, or
    /// decline its form (T-61 slice 2, D-7 (a)): 2.x then ends that run as
    /// it ends one shutting down, `execution.interrupted` with reason
    /// `shutdown` (probe p0 7d72ea4c), which, after this, ends Core's turn as
    /// declined. Not read from the events: 2.x rejects and cancels a pending
    /// request on a real shutdown too. `false` undoes it (2.x refused the answer).
    pub fn declining(&mut self, session: &str, declining: bool) {
        if let Some(open) = self.sessions.get_mut(session) {
            open.declined = declining;
        }
    }
}

/// One session's: the newest user message of the turn now open, and of each
/// answer, tool and streaming text under way what its later events do not
/// repeat.
#[derive(Default)]
struct Open {
    user: Option<String>,
    inputs: HashMap<String, String>,
    steps: HashMap<String, Step>,
    tools: HashMap<String, Tool>,
    gathered: HashMap<String, Gathered>,
    /// Each shell command running, by its shell's ID: its message's.
    shells: HashMap<String, String>,
    /// The compaction running: its message's ID.
    compaction: Option<String>,
    /// 2.x's own requests still open, oldest first, each with the kind of
    /// Core's event that ends it. A request lives only while its run does:
    /// 2.2.5 sends no reply for a permission request its interrupt ended
    /// (probe p3), so the run's end ends them in Core too (`ended`).
    requests: Vec<(String, &'static str)>,
    /// Core rejected or declined one of this run's requests (`declining`).
    declined: bool,
    /// The forms open now that are questions (their answer is the
    /// conversation's, kept in Core's journal; another form's is not, D-11).
    questions: HashSet<String>,
    /// Synthetic inputs admitted and not yet delivered that are a sub-agent's
    /// result (`metadata.source` `subagent`, 2.2.5 core/src/session/subagent-completion.ts):
    /// what 2.x runs of them is its own, never a command's (T-61 slice 3, D-15).
    results: HashSet<String>,
}

impl Open {
    fn is_empty(&self) -> bool {
        self.user.is_none() && self.inputs.is_empty() && self.steps.is_empty() && self.tools.is_empty() && self.gathered.is_empty()
            && self.shells.is_empty() && self.compaction.is_none() && self.requests.is_empty() && self.questions.is_empty()
            && self.results.is_empty()
            // Kept until the run Core declined a request of ends (D-7), after the request's own reply.
            && !self.declined
    }

    fn question(&mut self, form: &Value) {
        if let (Some(id), Some("question")) = (form["id"].as_str(), form["metadata"]["kind"].as_str()) {
            self.questions.insert(id.to_owned());
        }
    }

    fn asked(&mut self, id: Option<&str>, replied: &'static str) {
        if let Some(id) = id.filter(|id| !self.requests.iter().any(|(open, _)| open == id)) {
            self.requests.push((id.to_owned(), replied));
        }
    }

    /// The events of Core's shape one 2.x event stands for, in order. Another
    /// event of an answer first writes out the text gathered for its other
    /// entries (T-32 slice 4a; R2 and R5 notes): a later entry's, a tool's,
    /// its step's end.
    fn read(&mut self, event: &Value) -> Vec<Value> {
        let d = &event["data"];
        let Some(answer) = d["assistantMessageID"].as_str() else { return self.read_one(event) };
        let this = d["ordinal"].as_u64().map(|ordinal| entry_id(answer, ordinal));
        let others: Vec<String> = self.gathered.iter().filter(|(id, gathered)| gathered.message == answer && Some(id.as_str()) != this.as_deref())
            .map(|(id, _)| id.clone()).collect();
        let session = d["sessionID"].clone();
        let mut out: Vec<Value> = others.into_iter().filter_map(|id| self.gathered.remove(&id).map(|gathered| written(event, &session, &id, gathered)))
            .collect();
        out.extend(self.read_one(event));
        out
    }

    /// The events of Core's shape one 2.x event stands for, in order. A
    /// 1.19.3-shaped one is returned as it is; one Core takes nothing from,
    /// none.
    fn read_one(&mut self, event: &Value) -> Vec<Value> {
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
            // 2.x's form, asked and ended as Core's question is, read as Core keeps it (`request_of`).
            "form.created" => {
                self.asked(d["form"]["id"].as_str(), "question.replied");
                self.question(&d["form"]);
                vec![made("question.asked", request_of(&d["form"]))]
            }
            // Whether it was a question: only a question's answer is kept with the event (D-11).
            "form.replied" | "form.cancelled" => {
                self.requests.retain(|(open, _)| d["id"] != open.as_str());
                let question = d["id"].as_str().is_some_and(|id| self.questions.remove(id));
                vec![made("question.replied", json!({"sessionID": session, "requestID": d["id"], "question": question}))]
            }
            // 2.x's permission request passes as it is, kept until it ends.
            "permission.asked" => {
                self.asked(d["id"].as_str(), "permission.replied");
                vec![event.clone()]
            }
            "permission.replied" => {
                self.requests.retain(|(open, _)| d["requestID"] != open.as_str());
                vec![event.clone()]
            }
            "session.created" if d.get("info").is_none() => vec![made("session.created", json!({"sessionID": session,
                "info": {"id": session, "parentID": d["parentID"], "title": d["title"], "agent": d["agent"]}}))],
            "session.inbox.enqueued" => {
                let (Some(id), Some(item)) = (d["inboxID"].as_str(), d["item"]["type"].as_str()) else { return vec![] };
                self.inputs.insert(id.to_owned(), item.to_owned());
                if sub_agents_result(&d["item"]) {
                    self.results.insert(id.to_owned());
                }
                // Admitted: a user's message is stored (`admitted`), and answers nothing until delivered.
                if item == "user" { vec![message(user(id, at))] } else { vec![] }
            }
            "session.inbox.delivered" => {
                let Some(id) = d["inboxID"].as_str() else { return vec![] };
                // Only a user's or a synthetic input is a message a turn's answers can answer.
                let seen = self.inputs.remove(id);
                if !matches!(seen.as_deref(), None | Some("user" | "synthetic")) {
                    return vec![];
                }
                self.user = Some(id.to_owned());
                let mut info = user(id, at);
                // Admitted while this connection did not see it: what it was is not known here, so it is no
                // command's input (T-61 slice 3); nor is a sub-agent's result.
                if seen.is_none() {
                    info["_opencodeUnseen"] = true.into();
                }
                if self.results.remove(id) {
                    info[SUB_AGENTS_RESULT] = true.into();
                }
                vec![message(info)]
            }
            "session.step.started" => {
                let Some(id) = d["assistantMessageID"].as_str() else { return vec![] };
                // As 2.x stores an answer: started when the step says, ended at its end's event
                // (core/src/session/message-updater.ts), so a whole read says the same times.
                let created = if d["started"].is_number() { d["started"].clone() } else { at.clone() };
                let step = Step { parent: self.user.clone(), created, model: d["model"].clone() };
                let info = answer(id, step.parent.as_deref(), &step.created, &Value::Null, &Value::Null, &Value::Null, &Value::Null, &step.model);
                self.steps.insert(id.to_owned(), step);
                vec![message(info)]
            }
            "session.step.ended" | "session.step.failed" => {
                let Some(id) = d["assistantMessageID"].as_str() else { return vec![] };
                // An end of a step this connection never saw start answers nothing it knows of.
                let step = self.steps.remove(id).unwrap_or_default();
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
                let gathered = self.gathered.remove(&id).expect("gathered");
                vec![written(event, session, &id, gathered)]
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
            // One compaction, started and ended, is the one message 2.x stores for it (T-32 slice 4a, R3
            // notes): its input's ID, else its start event's (core/src/session/message-updater.ts).
            "session.compaction.started" => {
                let id = d["inputID"].as_str().map(str::to_owned).unwrap_or_else(|| from_event(event["id"].as_str().unwrap_or_default()));
                self.compaction = Some(id.clone());
                vec![message(compacted(&id, at))]
            }
            "session.compaction.ended" => {
                let id = self.compaction.take().unwrap_or_else(|| from_event(event["id"].as_str().unwrap_or_default()));
                vec![message(compacted(&id, at))]
            }
            // A shell command (T-32 slice 4a, D2): a command item of the newest message before it in its
            // turn, under the message 2.x stores for it (its start event's ID).
            "session.shell.started" => {
                let Some(shell) = d["shell"]["id"].as_str() else { return vec![] };
                let id = from_event(event["id"].as_str().unwrap_or_default());
                self.shells.insert(shell.to_owned(), id.clone());
                vec![message(shell_info(&id, self.user.as_deref(), at)), updated(shell_part(&id, &d["shell"], &Value::Null))]
            }
            "session.shell.ended" => {
                let Some(id) = d["shell"]["id"].as_str().and_then(|shell| self.shells.remove(shell)) else { return vec![] };
                vec![updated(shell_part(&id, &d["shell"], &d["output"]["output"]))]
            }
            "session.execution.started" => vec![status("busy")],
            "session.retry.scheduled" => vec![status("retry")],
            "session.execution.succeeded" => self.ended(event, vec![status("idle")]),
            "session.execution.failed" => self.ended(event, vec![failed(error(&d["error"], Some(EXECUTION_FAILED))), status("idle")]),
            // A run Core declined a request of ends as one shutting down does: declined (D-7 (a)).
            "session.execution.interrupted" if d["reason"] == "shutdown" && self.declined => self.ended(event,
                vec![failed(error(&json!({"type": "declined", "message": DECLINED}), Some(ABORTED))), status("idle")]),
            // A shutdown leaves the turn open: the execution resumes it (session-message.ts), and a Core that restarts reads it unknown.
            "session.execution.interrupted" if d["reason"] == "shutdown" => vec![],
            "session.execution.interrupted" => {
                let reason = Value::from(format!("interrupted ({})", d["reason"].as_str().unwrap_or("unknown")));
                self.ended(event, vec![failed(error(&json!({"type": "interrupted", "message": reason}), Some(ABORTED))), status("idle")])
            }
            _ if kind.starts_with("session.") && !is_v1_kind(kind) => vec![],
            _ => vec![event.clone()],
        }
    }

    /// A terminal execution event: its turn is over, and the next steps belong
    /// to the next one. What was gathered and not written yet is written first.
    fn ended(&mut self, event: &Value, read: Vec<Value>) -> Vec<Value> {
        let session = event["data"]["sessionID"].clone();
        let mut out: Vec<Value> = self.gathered.drain().map(|(id, gathered)| written(event, &session, &id, gathered)).collect();
        // Its requests still open end with it.
        out.extend(self.requests.drain(..).map(|(id, replied)| json!({"id": event["id"], "type": replied,
            "data": {"sessionID": session, "requestID": id}})));
        out.extend(read);
        self.user = None;
        self.steps.clear();
        self.tools.clear();
        self.declined = false;
        self.questions.clear();
        out
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
