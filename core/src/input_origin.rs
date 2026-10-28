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
/// - `native`: without a receipt, in a Claude Turn no prompt of yours started;
/// - `unconfirmed`: anything else.
pub(crate) fn annotate(db: &Connection, agent: &str, conversation: &mut [Value]) -> Result<()> {
    let clients: Vec<&str> = conversation.iter().flat_map(|turn| turn["items"].as_array().into_iter().flatten())
        .filter(|item| item["type"] == "userMessage").filter_map(|item| item["clientId"].as_str()).collect();
    let mut receipts = HashMap::new();
    let mut resumes = HashSet::new();
    if !clients.is_empty() {
        let mut query = db.prepare_cached("SELECT client_id, json_extract(data,'$.origin.kind'),
            json_extract(data,'$.input.clarification') IS NOT NULL, json_extract(data,'$.input.question') IS NOT NULL
            FROM agent_receipts WHERE agent_id=?1 AND client_id IN (SELECT value FROM json_each(?2))")?;
        for row in query.query_map(params![agent, json!(clients).to_string()], |r| {
            Ok((r.get::<_, String>(0)?, Receipt { origin: r.get(1)?, form: r.get(2)?, answer: r.get(3)? }))
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
        let mut first = true;
        for item in turn["items"].as_array_mut().into_iter().flatten().filter(|item| item["type"] == "userMessage") {
            let marked = item["_yuzunoSource"].as_str().or(source.as_deref().filter(|_| first));
            let client = item["clientId"].as_str();
            let receipt = client.and_then(|id| receipts.get(id));
            let by = match (marked, receipt) {
                (Some("peer"), _) => "peer",
                (Some(crate::brief_turns::REMINDER_SOURCE), _) => "reminder",
                (_, Some(Receipt { origin: Some(kind), form, answer })) => match kind.as_str() {
                    "client" if *form => "form",
                    "client" if *answer => "answer",
                    "client" => "you",
                    "home" => "home",
                    "resume" => "resume",
                    _ => "unconfirmed",
                },
                _ if client.is_some_and(|id| resumes.contains(id)) => "resume",
                (_, None) if source.as_deref() == Some("native") => "native",
                _ => "unconfirmed",
            };
            item["_yuzunoInput"] = by.into();
            first = false;
        }
    }
    Ok(())
}

struct Receipt {
    origin: Option<String>,
    form: bool,
    answer: bool,
}
