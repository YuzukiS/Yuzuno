//! Who each user message came from, as Core recorded it (T-6). Part of
//! `mailbox_notice::annotate_turns`, after the provenance it marks there:
//! another Agent's mail, a Yuzuno reminder. The rest is read from Core's own
//! rows, never from the text: the `origin` Core put on the message's receipt
//! when it took the message, and a Claude automatic continue's own row. A
//! receipt alone proves no one wrote it: one without an origin (written
//! before Core kept them) or no receipt at all is `unconfirmed`.
use anyhow::Result;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

/// The format of a Home reply's snapshot (T-9), `origin.home` on its
/// receipt (project_brief::home, snapshot).
pub(crate) const HOME_FORMAT: u64 = 1;
/// Larger than any snapshot Core writes: a reply is at most 20,000 bytes, a
/// question 500 characters, and a form's answers are in the reply's text.
const HOME_MAX_BYTES: usize = 128 * 1024;

/// `_yuzunoInput` values Core confirmed the person wrote.
pub(crate) const HUMAN: [&str; 4] = ["you", "home", "form", "answer"];

/// Listed to read the conversation by: the person's inputs, and inputs no
/// record attributes, shown apart from them.
pub(crate) fn navigable(by: &str) -> bool {
    HUMAN.contains(&by) || by == "unconfirmed"
}

/// Marks every user message `_yuzunoInput`:
/// - `peer`, `reminder`: as `_yuzunoSource` marks it, or its Turn's first;
/// - from its receipt's `origin`: sent from a client (`client`) as `you`, or
///   as `form` with answers to a form, `answer` to a native question; `home`,
///   a reply from Home; `resume`, a Claude automatic continue;
/// - `resume`, too: an automatic continue's client ID with its own row;
/// - `native`: without a receipt, in a Claude Turn Claude says it started
///   itself (its origin neither `human` nor `outside`, a terminal's prompt);
/// - `unconfirmed`: anything else.
///
/// A reply from Home also gets `_yuzunoHome` (T-9): the Project, section,
/// version and Workspace its receipt names, and `snapshot`, the reply as the
/// user saw it then, when the receipt has one of this format and shape.
pub(crate) fn annotate(db: &Connection, agent: &str, conversation: &mut [Value]) -> Result<()> {
    let clients: Vec<&str> = conversation.iter().flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .filter(|item| item["type"] == "userMessage").filter_map(|item| item["clientId"].as_str()).collect();
    let mut receipts = HashMap::new();
    let mut resumes = HashSet::new();
    if !clients.is_empty() {
        let mut query = db.prepare_cached("SELECT client_id, json_extract(data,'$.origin.kind'),
            json_extract(data,'$.input.clarification') IS NOT NULL, json_extract(data,'$.input.question') IS NOT NULL,
            CASE WHEN json_extract(data,'$.origin.kind')='home' THEN json_extract(data,'$.origin') END
            FROM agent_receipts WHERE agent_id=?1 AND client_id IN (SELECT value FROM json_each(?2))")?;
        for row in query.query_map(params![agent, json!(clients).to_string()], |r| {
            Ok((r.get::<_, String>(0)?, Receipt { origin: r.get(1)?, form: r.get(2)?, answer: r.get(3)?, home: r.get(4)? }))
        })? {
            let (client, receipt) = row?;
            receipts.insert(client, receipt);
        }
        let continues: Vec<&str> = clients.iter().filter_map(|id| id.strip_prefix(crate::claude_quota::RESUME_CLIENT_PREFIX)).collect();
        if !continues.is_empty() {
            let mut query = db.prepare_cached("SELECT id FROM claude_quota_resumes WHERE agent_id=?1 AND id IN (SELECT value FROM json_each(?2))")?;
            for id in query.query_map(params![agent, json!(continues).to_string()], |r| r.get::<_, String>(0))? {
                resumes.insert(format!("{}{}", crate::claude_quota::RESUME_CLIENT_PREFIX, id?));
            }
        }
    }
    for turn in conversation.iter_mut() {
        let source = turn["_yuzunoSource"].as_str().map(str::to_owned);
        let claude_started = source.as_deref() == Some("native")
            && turn["_yuzunoOrigin"].as_str().is_some_and(|kind| !matches!(kind, "human" | "outside"));
        let mut first = true;
        for item in turn["items"].as_array_mut().into_iter().flatten().filter(|item| item["type"] == "userMessage") {
            let marked = item["_yuzunoSource"].as_str().or(source.as_deref().filter(|_| first));
            let client = item["clientId"].as_str();
            let receipt = client.and_then(|id| receipts.get(id));
            let by = match (marked, receipt) {
                (Some("peer"), _) => "peer",
                (Some(crate::brief_turns::REMINDER_SOURCE), _) => "reminder",
                (_, Some(Receipt { origin: Some(kind), form, answer, .. })) => match kind.as_str() {
                    "client" if *form => "form",
                    "client" if *answer => "answer",
                    "client" => "you",
                    "home" => "home",
                    "resume" => "resume",
                    _ => "unconfirmed",
                },
                _ if client.is_some_and(|id| resumes.contains(id)) => "resume",
                (_, None) if claude_started => "native",
                _ => "unconfirmed",
            };
            item["_yuzunoInput"] = by.into();
            if let Some(object) = item.as_object_mut() {
                object.remove("_yuzunoHome");
            }
            if let Some(home) = receipt.filter(|_| by == "home").and_then(|r| r.home.as_deref()).and_then(home_reply) {
                item["_yuzunoHome"] = home;
            }
            first = false;
        }
    }
    Ok(())
}

struct Receipt {
    origin: Option<String>,
    form: bool,
    answer: bool,
    /// A Home reply's whole origin, as JSON.
    home: Option<String>,
}

/// A Home reply's `_yuzunoHome`, from its receipt's origin: none when the
/// origin does not name a Project, or names its section otherwise than Core
/// does. Its snapshot only when it is one Core
/// writes: this format, every field and no other, each of its type, within
/// the size Core writes. Anything else leaves it out, and the message is
/// shown as its text, never as part of a snapshot.
fn home_reply(origin: &str) -> Option<Value> {
    let origin: Value = serde_json::from_str(origin).ok()?;
    let named = |key: &str| matches!(origin.get(key), None | Some(Value::Null | Value::String(_)));
    let project = origin["projectId"].as_str()?;
    if !named("key") || !named("workspaceId") || !(origin["version"].is_null() || origin["version"].is_i64()) {
        return None;
    }
    // The section's identity on Home when the user replied (Home's `id`):
    // what tells the section answered from another later under its key.
    let section = match origin.get("sectionId") {
        None | Some(Value::Null) => None,
        Some(id) => Some(id.as_i64()?),
    };
    let mut home = json!({"projectId":project,"key":origin["key"],"version":origin["version"],"workspaceId":origin["workspaceId"]});
    if let Some(section) = section {
        home["sectionId"] = section.into();
    }
    if let Some(snapshot) = origin.get("home").filter(|snapshot| snapshot_shape(snapshot) && snapshot.to_string().len() <= HOME_MAX_BYTES) {
        home["snapshot"] = snapshot.clone();
    }
    Some(home)
}

const SNAPSHOT_FIELDS: [&str; 9] = ["format", "projectName", "sectionKind", "title", "question", "options", "choice", "text", "form"];

fn snapshot_shape(snapshot: &Value) -> bool {
    let Some(fields) = snapshot.as_object() else { return false };
    if fields.len() != SNAPSHOT_FIELDS.len() || !SNAPSHOT_FIELDS.iter().all(|key| fields.contains_key(*key)) {
        return false;
    }
    let string = |value: Option<&Value>| value.is_some_and(Value::is_string);
    let text = |value: &Value| value.is_null() || value.is_string();
    let option = |value: &Value| value.as_object().is_some_and(|o| o.len() == 2 && string(o.get("id")) && string(o.get("label")));
    let field = |value: &Value| value.as_object().is_some_and(|f| {
        f.len() == 4 && string(f.get("id")) && string(f.get("label")) && match (f.get("type").and_then(Value::as_str), f.get("answer")) {
            (Some("text" | "single"), Some(Value::String(_))) => true,
            (Some("multi"), Some(Value::Array(answers))) => answers.iter().all(Value::is_string),
            _ => false,
        }
    });
    let form = |value: &Value| value.is_null() || value.as_object().is_some_and(|form| {
        form.len() == 3 && string(form.get("id")) && string(form.get("title"))
            && form.get("fields").and_then(Value::as_array).is_some_and(|fields| fields.iter().all(field))
    });
    fields["format"].as_u64() == Some(HOME_FORMAT)
        && fields["projectName"].is_string()
        && (fields["sectionKind"].is_null() || matches!(fields["sectionKind"].as_str(), Some("ask" | "report" | "status")))
        && text(&fields["title"]) && text(&fields["question"]) && text(&fields["text"])
        && (fields["options"].is_null() || fields["options"].as_array().is_some_and(|options| options.iter().all(option)))
        && (fields["choice"].is_null() || option(&fields["choice"]))
        && form(&fields["form"])
}
