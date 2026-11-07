//! What Core gave a native session the last time it attached it (YN-5): a
//! digest of each Yuzuno tool's definition (its description, each top-level
//! parameter and its required list) and of the text Core gives a session as
//! it starts (the session notice and Brief hard rules Core adds to Claude's
//! system prompt and to Codex's developer instructions, and the MCP server
//! instructions).
//!
//! Claude Code 2.1.318 keeps, for the whole conversation, the tool
//! definitions it loaded and the system prompt it started with: a resume, a
//! reconnect, a new ToolSearch or tools/list_changed changes neither, and
//! only compaction refreshes the tools (YN-5 labs r1b, r3, r3b). So when Core
//! attaches an existing session again and either has changed since, it mails
//! that session one notice of what changed, with the current definitions
//! (capped). Mail reaches the conversation, which the start text cannot. A
//! new session, an unchanged one, or one Core has no record of gets none.
//!
//! The notice joins, it does not ring (Lead 2, mail 7114): it never starts a
//! Turn by itself. It goes with the Agent's next doorbell, read before the
//! other mail, or into the Turn it is running (pending_peer_deliveries,
//! peer_read). Its one cost: an Agent woken by something else reads it in
//! that Turn. A session that never works again never sees it.
use crate::model::Agent;
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::sync::OnceLock;

/// The notice's `metadata.kind`: mail that joins a doorbell, never rings one.
pub(crate) const KIND: &str = "session_changed";

/// At most this many changed tools are shown with what changed, together at
/// most `UNITS` UTF-16 units (Lead 2, mails 7097 and 7108). A tool whose
/// change alone is larger is shown by its description and the names of its
/// changed parameters; past either limit a tool is named only. The start
/// text has the same cap. Measured on the core.24 list: task_dispatch's
/// whole input schema is 6,483 units and job_submit's 10,600, so whole
/// schemas would not fit even one; #658's change to task_dispatch (its
/// description and executor) is about 3,200.
pub(crate) const TOOLS_SHOWN: usize = 4;
pub(crate) const UNITS: usize = 6000;

/// Runs on every open, like `agent_roles::migrate`: idempotent, whatever
/// the schema number.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS session_baselines(
            agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
            -- The native session it describes: NULL until Core knows its ID
            -- (a new Claude session is named by its first turn).
            native_id TEXT,
            -- {\"<tool>\": {\"description\": sha256, \"parameters\": {\"<name>\": sha256}, \"required\": sha256}}
            tools TEXT NOT NULL,
            -- sha256 of the start text; empty for a harness Core gives none.
            start_text TEXT NOT NULL,
            updated_at TEXT NOT NULL);
        DELETE FROM session_baselines WHERE agent_id NOT IN (SELECT id FROM agents);",
    )?;
    Ok(())
}

/// One tool's parts, each digested on its own.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
struct Digests {
    description: String,
    parameters: BTreeMap<String, String>,
    required: String,
}

struct Tool {
    name: String,
    definition: Value,
    digests: Digests,
}

/// Object keys sorted at every level, so a digest depends on what a
/// definition says, not on the order its keys were written in.
fn canonical(value: &Value) -> String {
    fn sorted(value: &Value) -> Value {
        match value {
            Value::Object(map) => {
                let mut keys: Vec<_> = map.keys().collect();
                keys.sort();
                Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&map[k]))).collect::<Map<_, _>>())
            }
            Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
            other => other.clone(),
        }
    }
    sorted(value).to_string()
}

fn sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn digests(definition: &Value) -> Digests {
    let schema = &definition["inputSchema"];
    Digests {
        description: sha256(&canonical(&definition["description"])),
        parameters: schema["properties"].as_object().map(|properties| {
            properties.iter().map(|(name, value)| (name.clone(), sha256(&canonical(value)))).collect()
        }).unwrap_or_default(),
        required: sha256(&canonical(&schema["required"])),
    }
}

/// This Core's Yuzuno tools, in the order the MCP server lists them.
fn catalog() -> &'static [Tool] {
    static CATALOG: OnceLock<Vec<Tool>> = OnceLock::new();
    CATALOG.get_or_init(|| {
        crate::collaboration_store::tool_definitions().into_iter().map(|definition| Tool {
            name: definition["name"].as_str().unwrap_or_default().to_owned(),
            digests: digests(&definition),
            definition,
        }).collect()
    })
}

/// One digest of the whole tool list: names a development build's list in
/// the MCP server's version, where there is no release ID.
pub(crate) fn catalog_digest() -> &'static str {
    static DIGEST: OnceLock<String> = OnceLock::new();
    DIGEST.get_or_init(|| sha256(&catalog().iter().map(|tool| canonical(&tool.definition)).collect::<Vec<_>>().join("\n")))
}

fn baseline() -> BTreeMap<String, Digests> {
    catalog().iter().map(|tool| (tool.name.clone(), tool.digests.clone())).collect()
}

/// What changed in one tool since a session was attached with `before`.
#[derive(Debug, Default, PartialEq)]
struct Change {
    description: bool,
    /// Added or changed parameters, by name.
    parameters: Vec<String>,
    removed: Vec<String>,
    required: bool,
}

#[derive(Debug, Default, PartialEq)]
struct Changes {
    added: Vec<String>,
    removed: Vec<String>,
    changed: Vec<(String, Change)>,
}

impl Changes {
    fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.changed.is_empty()
    }
}

fn changes(before: &BTreeMap<String, Digests>) -> Changes {
    let mut changes = Changes::default();
    for tool in catalog() {
        let Some(old) = before.get(&tool.name) else {
            changes.added.push(tool.name.clone());
            continue;
        };
        if *old == tool.digests {
            continue;
        }
        let now = &tool.digests;
        let schema_order = tool.definition["inputSchema"]["properties"].as_object();
        let change = Change {
            description: old.description != now.description,
            parameters: schema_order.map(|properties| properties.keys()
                .filter(|name| old.parameters.get(*name) != now.parameters.get(*name))
                .cloned().collect()).unwrap_or_default(),
            removed: old.parameters.keys().filter(|name| !now.parameters.contains_key(*name)).cloned().collect(),
            required: old.required != now.required,
        };
        changes.changed.push((tool.name.clone(), change));
    }
    changes.removed = before.keys().filter(|name| !catalog().iter().any(|tool| &tool.name == *name)).cloned().collect();
    changes
}

fn units(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text` within `limit` UTF-16 units, cut at a character and marked so.
fn capped(text: &str, limit: usize) -> String {
    if units(text) <= limit {
        return text.to_owned();
    }
    let mark = " … (cut)";
    let mut kept = String::new();
    let mut used = units(mark);
    for c in text.chars() {
        used += c.len_utf16();
        if used > limit {
            break;
        }
        kept.push(c);
    }
    kept + mark
}

/// One changed tool, briefly: its current description and the names of
/// what changed, for a change too large to show whole.
fn named(tool: &Tool, change: &Change) -> String {
    let mut lines = vec![format!("{}:", tool.name), format!("  description: {}", tool.definition["description"])];
    if !change.parameters.is_empty() {
        lines.push(format!("  changed parameters (definitions not shown): {}", change.parameters.join(", ")));
    }
    if !change.removed.is_empty() {
        lines.push(format!("  removed parameters: {}", change.removed.join(", ")));
    }
    if change.required {
        lines.push(format!("  required: {}", tool.definition["inputSchema"]["required"]));
    }
    lines.join("\n")
}

/// One changed tool's current definition, only the parts that changed.
fn shown(tool: &Tool, change: &Change) -> String {
    let mut lines = vec![format!("{}:", tool.name)];
    if change.description {
        lines.push(format!("  description: {}", tool.definition["description"]));
    }
    for name in &change.parameters {
        lines.push(format!("  parameter {name}: {}", tool.definition["inputSchema"]["properties"][name]));
    }
    if !change.removed.is_empty() {
        lines.push(format!("  removed parameters: {}", change.removed.join(", ")));
    }
    if change.required {
        lines.push(format!("  required: {}", tool.definition["inputSchema"]["required"]));
    }
    lines.join("\n")
}

/// The notice, or nothing when neither the tools nor the start text changed.
fn notice(changes: &Changes, start_text: Option<&str>) -> Option<String> {
    if changes.is_empty() && start_text.is_none() {
        return None;
    }
    let release = crate::guide::release();
    let mut text = format!(
        "[Yuzuno Core: what this conversation was given has changed]\nThis Core ({}) attached this conversation again. \
         Since it was last attached here, the following changed. Your client may keep what it loaded earlier for the rest \
         of this conversation (Claude Code keeps tool definitions until the conversation is compacted, and its start text \
         for good): where this notice and an earlier definition differ, this notice is current. Core accepts the current \
         parameters, even ones an earlier definition lacks. Nothing needs doing now; no reply is needed.",
        release["releaseId"].as_str().unwrap_or("development"),
    );
    if !changes.is_empty() {
        text.push_str("\n\nYuzuno tools:");
        let names = |list: &[String]| list.join(", ");
        if !changes.changed.is_empty() {
            text.push_str(&format!("\n- changed: {}", names(&changes.changed.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>())));
        }
        if !changes.added.is_empty() {
            text.push_str(&format!("\n- added: {}", names(&changes.added)));
        }
        if !changes.removed.is_empty() {
            text.push_str(&format!("\n- removed: {}", names(&changes.removed)));
        }
        let (mut parts, mut used, mut only_named) = (Vec::new(), 0, Vec::new());
        for (name, change) in &changes.changed {
            let Some(tool) = catalog().iter().find(|tool| &tool.name == name) else { continue };
            let whole = shown(tool, change);
            let part = if units(&whole) <= UNITS { whole } else { named(tool, change) };
            if parts.len() < TOOLS_SHOWN && used + units(&part) <= UNITS {
                used += units(&part);
                parts.push(part);
            } else {
                only_named.push(name.clone());
            }
        }
        if !parts.is_empty() {
            text.push_str("\n\nWhat changed, as this Core defines it now (JSON):\n");
            text.push_str(&parts.join("\n"));
        }
        if !only_named.is_empty() {
            text.push_str(&format!("\n\nNot shown here (more than {TOOLS_SHOWN} tools or {UNITS} UTF-16 units): {}.", only_named.join(", ")));
        }
    }
    if let Some(start) = start_text {
        text.push_str("\n\nThe text Core gives a session as it starts (the Yuzuno session notice, the Project Brief rules \
            and the yuzuno MCP server instructions) has changed. Now it reads:\n");
        text.push_str(&capped(start, UNITS));
    }
    Some(text)
}

/// Records what `agent`'s native session is attached with now and, when
/// that session was attached before with something else, mails it the
/// notice in the same transaction. The mail's ID, if one was sent.
pub(crate) fn attach(db: &Connection, agent: &Agent, start_text: Option<&str>) -> Result<Option<String>> {
    let native = match agent.harness.as_str() {
        "claude" => agent.claude_session_id.as_deref(),
        "opencode" => agent.opencode_session_id.as_deref(),
        _ => agent.thread_id.as_deref(),
    };
    let start_digest = start_text.map(sha256).unwrap_or_default();
    let tools_now = serde_json::to_string(&baseline())?;
    let before: Option<(Option<String>, String, String)> = db.query_row(
        "SELECT native_id, tools, start_text FROM session_baselines WHERE agent_id=?1",
        [&agent.id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
    ).optional()?;
    // The same session: the one recorded, or the one it became (a new
    // Claude session had no ID when it was recorded). Anything else is a
    // session this record does not describe.
    let mut mail = None;
    if let (Some(native), Some((recorded, tools, start))) = (native, &before) {
        if recorded.as_deref().is_none_or(|recorded| recorded == native) {
            let loaded: BTreeMap<String, Digests> = serde_json::from_str(tools).unwrap_or_default();
            let changed = changes(&loaded);
            let start_changed = start_text.filter(|_| start != &start_digest);
            if let Some(body) = notice(&changed, start_changed) {
                mail = Some(send(db, agent, body, &changed, start_changed.is_some())?);
            }
        }
    }
    let unchanged = mail.is_none() && before.as_ref().is_some_and(|(recorded, tools, start)| {
        recorded.as_deref() == native && tools == &tools_now && start == &start_digest
    });
    if !unchanged {
        db.execute(
            "INSERT INTO session_baselines(agent_id,native_id,tools,start_text,updated_at) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(agent_id) DO UPDATE SET native_id=excluded.native_id, tools=excluded.tools,
               start_text=excluded.start_text, updated_at=excluded.updated_at",
            params![agent.id, native, tools_now, start_digest, crate::model::now()],
        )?;
    }
    Ok(mail)
}

fn send(db: &Connection, agent: &Agent, body: String, changes: &Changes, start_changed: bool) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let changed: Vec<&str> = changes.changed.iter().map(|(name, _)| name.as_str()).collect();
    crate::collaboration_store::insert_message(db, json!({"id":id,"seq":0,
        "sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
        "recipient":{"kind":"agent","id":agent.id,"name":agent.name},"body":body,"taskId":null,
        "replyTo":null,"threadId":id,"createdAt":crate::model::now(),"priority":"normal",
        "source":{"sessionAttach":agent.id},
        "metadata":{"kind":KIND,"name":"Yuzuno Core","status":"changed",
            "tools":{"changed":changed,"added":changes.added,"removed":changes.removed},"startText":start_changed}}))?;
    Ok(id)
}

impl crate::workspace::Workspace {
    /// The text Core gives `agent`'s session as it starts: for Claude and
    /// Codex the session notice and, for a Project's Agent, the Brief hard
    /// rules (claude.rs start, results::with_capability_notice and
    /// brief_turns::with_hard_rules); for every harness the MCP server
    /// instructions.
    async fn start_text(&self, agent: &Agent) -> String {
        let mut parts = Vec::new();
        if matches!(agent.harness.as_str(), "claude" | "codex") {
            parts.push(crate::guide::session_notice().to_owned());
            if let Some(rules) = crate::brief_turns::start_hard_rules(self, &agent.id).await {
                parts.push(rules);
            }
        }
        parts.push(crate::collaboration_mcp::server_instructions());
        parts.join("\n\n")
    }

    /// Called once a native session's Workspace MCP is confirmed ready on
    /// transport `generation`. A failure here never fails the connection.
    pub(crate) async fn session_attached(&self, id: &str, generation: u64) {
        if self.collaboration_url.get().is_none() || self.collaboration_generation(id) != Some(generation) {
            return;
        }
        let agent_id = id.to_owned();
        let Ok(agent) = self.stored(move |store| store.agent(&agent_id)).await else { return };
        if agent.closed_at.is_some() {
            return;
        }
        let start = self.start_text(&agent).await;
        let mailed = self.stored(move |store| {
            let mut writer = store.db.write()?;
            let tx = writer.transaction()?;
            let mailed = attach(&tx, &agent, Some(&start))?;
            tx.commit()?;
            Ok(mailed)
        }).await;
        match mailed {
            Ok(Some(_)) => {
                self.collaboration_wakeup.notify_one();
                let _ = self.changes.send(json!({"collaboration":true,"tasks":false}));
            }
            Ok(None) => {}
            Err(error) => eprintln!("Agent {id}'s session baseline was not recorded: {error:#}"),
        }
    }
}

#[cfg(test)]
#[path = "session_baseline_tests.rs"]
mod tests;
