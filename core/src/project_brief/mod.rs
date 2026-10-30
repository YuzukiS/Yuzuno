//! Project Briefs (T-85, docs/home-v1.md): what each Project's Agents tell
//! the user, kept by Core outside the conversations. Agents write them with
//! `brief_update`; Home (see `home`) shows them beside the facts Core holds.
//!
//! Only rules a machine can check are enforced: shape and per-block limits
//! (the generated validator, results::Validator), the version an update was
//! based on, who owns a section, and the per-Brief limits. What a section
//! says is never judged, and nothing is derived from conversations. An
//! accepted update leaves a receipt bound to the Agent, its Project and the
//! Turn Core vouches for (results::reliable_turn); the turn-end check reads
//! those receipts through the functions below.
//!
//! Rust naming: `store::Brief` is an Agent's listed view; everything here is
//! a Project Brief.
mod attachments;
/// A Workspace backup's hold on Brief attachment files (T-192).
pub(crate) use attachments::hold_all as hold_attachments;
#[cfg(test)]
pub(crate) use attachments::{collect_garbage as collect_attachment_garbage, held as attachment_held};
mod editors;
mod home;
mod http;
mod presentation;
mod refs;
mod sections;
mod update;
mod writes;
#[cfg(test)]
mod preview_tests;
#[cfg(test)]
mod tests;

use crate::{model::now, store::Store, workspace::Workspace};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Arc, OnceLock};

/// The kept file of a section's attachment, in the version given or the
/// section's latest, for an interactive preview (previews.rs).
pub(crate) async fn attachment_file(ws: &Arc<Workspace>, project: &str, section: &str, name: &str, version: Option<i64>)
    -> Result<std::path::PathBuf> {
    let cache = attachments::dir(&ws.data_dir);
    let (project, section, name) = (project.to_owned(), section.to_owned(), name.to_owned());
    let found = ws.stored(move |store| attachments::snapshot_file(store, &cache, &project, &section, &name, version)).await?;
    found.map(|(path, _)| path).map_err(|missing| anyhow::anyhow!("{}: {}", missing.code, missing.message))
}

pub(crate) use update::TOOL as UPDATE_TOOL;

pub(crate) const MAX_TOPICS: usize = 12;
pub(crate) const MAX_SUBTOPICS: usize = 4;
pub(crate) const MAX_OPEN_ASKS: usize = 3;
pub(crate) const MAX_ATTACHMENTS: usize = 12;
/// A file up to this size is kept as it was; a larger one is referenced.
pub(crate) const SNAPSHOT_FILE_BYTES: u64 = 25 * 1024 * 1024;
/// Snapshots one Brief keeps, live sections and history together.
pub(crate) const SNAPSHOT_BRIEF_BYTES: u64 = 1024 * 1024 * 1024;
/// Seen reports and removed or resolved sections stay this long.
pub(crate) const HISTORY_DAYS: i64 = 30;
/// Turns ended without an update are shown on Home for this long.
pub(crate) const MISSING_HOURS: i64 = 24;
/// Turn outcomes (`project_brief_turns.outcome`). Only `reminded` may still
/// change; every other outcome is final once recorded.
pub const OUTCOMES: [&str; 6] = ["updated", "noChange", "missing", "reminded", "remindFailed", "skipped"];

#[cfg(test)]
const TOOLS: [&str; 3] = ["brief_get", "brief_update", "brief_guide"];
const GUIDE_PARTS: [&str; 8] = ["sections", "ask", "content", "charts", "attachments", "limits", "errors", "examples"];

fn contract() -> &'static Value {
    static CONTRACT: OnceLock<Value> = OnceLock::new();
    CONTRACT.get_or_init(|| {
        serde_json::from_str(include_str!("../../../runtimes/result-validator/contract.json"))
            .expect("generated result contract")
    })
}

/// The contract's `brief` part. None while the generated contract predates
/// Project Briefs: tools still list (with the texts below), and sections are
/// not accepted, since nothing could check them.
fn brief_contract() -> Option<&'static Value> {
    contract().get("brief").filter(|brief| brief.is_object())
}

fn contract_text(value: &'static Value) -> Option<&'static str> {
    value.as_str().filter(|text| !text.trim().is_empty())
}

const FALLBACK_RULES: &str = "Project Brief rules (Yuzuno). Nothing requires a Brief update each Turn: update it when something changed. \
Only the user selects content editors. When editContent=false and writeOwnAsk=true, only your own Asks are allowed. When writeOwnAsk=false the Brief is read-only. \
Call brief_get, then brief_update with the expectedVersion it returned: put, resolve, remove or claim your sections. A rejected call changes nothing: fix the listed problems \
(on version_conflict use the latest Brief attached) and call again with a new requestId. \
Only a section's owner changes it; to add to another Agent's topic, put a sub-topic such as topic/review. \
Kinds: ask (a question with options, freeText, form or choice; a reply marks it replied and it stays until you resolve it once handled), \
report (leaves when the user marks it seen), status (current data with asOf and validFor). \
Write conclusions, decisions and asks for the user, not a transcript; the Brief does not replace your reply. \
Details and examples: brief_guide.";

const FALLBACK_GUIDE: &str = "Project Brief guide.\n\
Sections: brief_update changes take op put, edit, resolve, remove or claim, and a key: topic or topic/sub (lowercase letters, digits, -). \
At most 12 topics with 4 sub-topics each. Only the owner changes a section; add to another Agent's topic with a sub-topic. \
A section whose owner was closed or deleted can be claimed by an Agent of the same Project; change it in a later brief_update.\n\
put: {op:'put', key, kind:'ask'|'report'|'status', title, body, ask?, status?, time?, attachments?}. body is {root, elements} with a BriefBody root.\n\
edit: {op:'edit', key, elements:{id: block}, status?} replaces those blocks of your section by id and keeps everything else.\n\
ask: ask.question plus at least one of reply.options (2-8), reply.freeText, reply.form or reply.choice. At most 3 unresolved asks per Agent. \
A user's reply marks it replied (out of Needs you, listed in brief_get you.repliedAsks); resolve it once handled: a preference when taken in, \
an authorized action only after it is done, with its result on the Task or Brief. While it runs or after it fails, keep it replied and report progress.\n\
status: status.asOf (ISO time) and status.validFor (seconds); it greys out when stale.\n\
attachments: up to 12 per section, {name, path (absolute, on the Core host) or url (https), caption?}. Files up to 25 MB are kept as snapshots; \
charts read only snapshot data files (CSV, JSON, JSONL).\n\
errors: a rejection lists problems with a code, a path and the guide part to read; nothing was changed.";

/// Where an outcome belongs on Home, in one sentence (BRIEF_OUTCOME_HINT in
/// brief-contract.ts): shown to content editors only, and only as advice.
pub fn outcome_hint() -> &'static str {
    brief_contract().and_then(|brief| contract_text(&brief["outcomeHint"])).unwrap_or(FALLBACK_HINT)
}

const FALLBACK_HINT: &str = "Home: a lasting finding, decision or stage result goes in a short report linked to its Task and sources; \
a current state in a status; a choice for the user in an ask. result_publish shows only in this turn.";

/// The hard rules, at most 1500 characters, in the MCP server instructions.
pub fn hard_rules() -> &'static str {
    brief_contract().and_then(|brief| contract_text(&brief["hardRules"])).unwrap_or(FALLBACK_RULES)
}

fn description(tool: &str) -> &'static str {
    let generated = brief_contract().and_then(|brief| contract_text(&brief["toolDescriptions"][tool]));
    generated.unwrap_or(match tool {
        "brief_get" => "Read your Project's Brief: its version and sections (with owners and ask state), what you own, your asks the user replied to, and the limits. Call it before brief_update; its version is your expectedVersion.",
        "brief_update" => "Change your Project's Brief, once per Turn: put, edit (replace blocks by id), resolve, remove or claim sections, or noChange:true when nothing of yours changed. Needs the expectedVersion from brief_get; it is rejected, with the latest Brief attached, when a section it changes was written since. Rejections list problems to fix; see brief_guide.",
        _ => "The Project Brief guide: section kinds, keys and owners, asks, content blocks, charts, attachments, limits and rejection codes, with examples. Pass part to read one part.",
    })
}

fn guide_parts() -> Vec<String> {
    match brief_contract().and_then(|brief| brief["guideParts"].as_object()) {
        Some(parts) if !parts.is_empty() => parts.keys().cloned().collect(),
        _ => GUIDE_PARTS.iter().map(|part| part.to_string()).collect(),
    }
}

/// One of the three Brief tools, as collaboration_store lists them.
pub(crate) fn tool_definition(name: &str) -> Value {
    let project = json!({"type":"string","description":"Project ID from projects_list. Omit for your own Project."});
    let (properties, required): (Value, &[&str]) = match name {
        "brief_get" => (json!({"projectId":project,"keys":{"type":"array","maxItems":MAX_KEYS,"items":{"type":"string"},
            "description":"Omit for every section with its body. [] for an index of the sections without bodies; [key, ...] for those sections in full, with the index."}}), &[]),
        "brief_update" => (update_properties(project), &["requestId", "expectedVersion"]),
        "brief_guide" => (
            json!({"part":{"type":"string","enum":guide_parts(),"description":"One part of the guide; omit for all of it."}}),
            &[],
        ),
        _ => panic!("unknown Brief tool {name}"),
    };
    let mut tool = json!({"name":name,"description":description(name),
        "inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}});
    if name != "brief_guide" {
        // Claude loads these without a tool search (see docs/home-v1.md).
        tool["_meta"] = json!({"anthropic/alwaysLoad":true});
    }
    tool
}

fn update_properties(project: Value) -> Value {
    let attachment = json!({"type":"object","additionalProperties":false,"required":["name"],"properties":{
        "name":{"type":"string","pattern":"^[\\w.-]{1,80}$"},
        "path":{"type":"string","description":"Absolute path of a file on the Core host. Up to 25 MB it is kept as a snapshot; otherwise only referenced."},
        "url":{"type":"string","description":"An https link, shown only as a link."},
        "caption":{"type":"string"}}});
    json!({
        "requestId":{"type":"string","minLength":1,"maxLength":128,"description":"Stable retry key. Reuse only when retrying exactly this update."},
        "projectId":project,
        "expectedVersion":{"type":"integer","minimum":0,"description":"The Brief version brief_get returned (0 for a Brief with no sections yet)."},
        "noChange":{"type":"boolean","description":"true, with no changes: nothing of yours changed in this Turn."},
        "validateOnly":{"type":"boolean","description":"true: only pre-check this update: the checks before its write, nothing written or reserved, not this Turn's update. The write itself checks again and can still refuse it."},
        "changes":{"type":"array","maxItems":update::MAX_CHANGES,"items":{"type":"object","required":["op","key"],"properties":{
            "op":{"type":"string","enum":["put","edit","resolve","remove","claim"]},
            "key":{"type":"string","description":"topic or topic/sub: lowercase letters, digits and -, each part up to 48 characters."},
            "kind":{"type":"string","enum":["ask","report","status"]},
            "title":{"type":"string","minLength":1,"maxLength":120},
            "body":{"type":"object","description":"A json-render spec {root, elements} with a BriefBody root; see brief_guide content."},
            "elements":{"type":"object","description":"For edit: block ids mapped to their new {type, props, children?}; the section's other blocks, title, attachments and ask state are kept. See brief_guide sections."},
            "ask":{"type":"object","description":"For kind ask: {question, reply:{options?, freeText?, form?, choice?}}."},
            "status":{"type":"object","description":"For kind status: {asOf: ISO time, validFor: seconds}."},
            "time":{"type":"object","description":"{due?, eta?, nextUpdate?} as ISO times."},
            "attachments":{"type":"array","maxItems":MAX_ATTACHMENTS,"items":attachment}}}}
    })
}

/// The schema version the validator's Brief answers carry.
pub(crate) fn brief_schema_version() -> Option<u64> {
    brief_contract().and_then(|brief| brief["schemaVersion"].as_u64())
}

/// What brief_get reports as limits: the contract's (Core enforces the same
/// numbers, see tests), or Core's own while the contract has none.
fn limits() -> Value {
    if let Some(limits) = brief_contract().map(|brief| &brief["limits"]).filter(|limits| limits.is_object()) {
        return limits.clone();
    }
    json!({"topics":MAX_TOPICS,"subtopicsPerTopic":MAX_SUBTOPICS,"openAsksPerAgent":MAX_OPEN_ASKS,
        "attachments":MAX_ATTACHMENTS,"snapshotFileBytes":SNAPSHOT_FILE_BYTES,
        "snapshotBriefBytes":SNAPSHOT_BRIEF_BYTES,"historyDays":HISTORY_DAYS})
}

/// `brief_guide`: the guide generated from the contract, whole or one part.
pub(crate) fn guide(input: &Value) -> Result<Value> {
    if let Some(key) = input.as_object().and_then(|o| o.keys().find(|key| *key != "part")) {
        bail!("invalid_input: unknown argument {key}");
    }
    let part = match input.get("part") {
        None | Some(Value::Null) => None,
        Some(Value::String(part)) => Some(part.as_str()),
        _ => bail!("invalid_input: part must be a string"),
    };
    let generated = brief_contract();
    let text = match (part, generated.and_then(|brief| brief["guideParts"].as_object())) {
        (Some(part), Some(parts)) => parts.get(part).and_then(Value::as_str).with_context(|| {
            format!("invalid_input: part is one of {}", parts.keys().cloned().collect::<Vec<_>>().join(", "))
        })?,
        (Some(part), None) => {
            ensure!(GUIDE_PARTS.contains(&part), "invalid_input: part is one of {}", GUIDE_PARTS.join(", "));
            FALLBACK_GUIDE
        }
        (None, _) => generated.and_then(|brief| contract_text(&brief["guide"])).unwrap_or(FALLBACK_GUIDE),
    };
    Ok(json!({"schemaVersion":brief_schema_version(),"part":part,"guide":text}))
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    // One row per section: the live one per key (live=1), and history (seen
    // reports, removed and resolved sections). A key's versions keep rising
    // across both, so a version once seen never names newer content.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_brief_editors(
        project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
        version INTEGER NOT NULL, editor_ids TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_briefs(
        project_id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS project_brief_sections(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, key TEXT NOT NULL,
        live INTEGER NOT NULL, kind TEXT NOT NULL, version INTEGER NOT NULL,
        owner_id TEXT NOT NULL, owner_name TEXT NOT NULL, data TEXT NOT NULL,
        ask_state TEXT, ask_since TEXT, replied_at TEXT, reply_text TEXT, deferred_until TEXT,
        updated_at TEXT NOT NULL, updated_turn_id TEXT, history_reason TEXT, history_at TEXT);
        CREATE UNIQUE INDEX IF NOT EXISTS project_brief_sections_live
        ON project_brief_sections(project_id,key) WHERE live=1;
        CREATE INDEX IF NOT EXISTS project_brief_sections_history
        ON project_brief_sections(project_id,history_at) WHERE live=0;
        CREATE TABLE IF NOT EXISTS project_brief_seen(
        project_id TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, at TEXT NOT NULL,
        PRIMARY KEY(project_id,key));
        CREATE TABLE IF NOT EXISTS project_brief_receipts(
        id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, project_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        session_id TEXT, kind TEXT NOT NULL, request_id TEXT NOT NULL, version INTEGER NOT NULL,
        created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS project_brief_receipts_turn ON project_brief_receipts(agent_id,turn_id);
        CREATE TABLE IF NOT EXISTS project_brief_turns(
        agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, project_id TEXT NOT NULL, outcome TEXT NOT NULL,
        reminders INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(agent_id,turn_id));
        CREATE INDEX IF NOT EXISTS project_brief_turns_project ON project_brief_turns(project_id,updated_at);
        -- The snapshot index: which section row keeps which snapshot file.
        CREATE TABLE IF NOT EXISTS project_brief_snapshots(
        section_seq INTEGER NOT NULL, project_id TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
        PRIMARY KEY(section_seq,sha256));
        CREATE INDEX IF NOT EXISTS project_brief_snapshots_sha ON project_brief_snapshots(sha256);",
    )?;
    // lineage: the seq of the section a row continues on Home (see update.rs,
    // put after a Seen); NULL when it is its own. Older Cores ignore it.
    let has_lineage: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('project_brief_sections') WHERE name='lineage')", [], |r| r.get(0))?;
    if !has_lineage {
        db.execute_batch("ALTER TABLE project_brief_sections ADD COLUMN lineage INTEGER")?;
    }
    // How each key's newest section last left the live Brief: its owner,
    // identity, version and why (seen, removed, resolved). One small row
    // per key, kept when history expires, so a seen report's owner writing
    // it again continues the same section however long after, and versions
    // keep rising (see update.rs).
    let has_endings: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_brief_endings')", [], |r| r.get(0))?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_brief_endings(
        project_id TEXT NOT NULL, key TEXT NOT NULL, owner_id TEXT NOT NULL, identity INTEGER NOT NULL,
        version INTEGER NOT NULL, reason TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(project_id,key));",
    )?;
    if !has_endings {
        // Keys whose newest row is already history when this table appears.
        db.execute(
            "INSERT OR IGNORE INTO project_brief_endings(project_id,key,owner_id,identity,version,reason,at)
             SELECT s.project_id,s.key,s.owner_id,COALESCE(s.lineage,s.seq),s.version,COALESCE(s.history_reason,'removed'),
             COALESCE(s.history_at,s.updated_at) FROM project_brief_sections s WHERE s.live=0
             AND s.seq=(SELECT MAX(seq) FROM project_brief_sections t WHERE t.project_id=s.project_id AND t.key=s.key)",
            [],
        )?;
    }
    // The Brief version of each key's last Agent write, and a base row per
    // Project (writes.rs): section-level checks of brief_update (T-9).
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_brief_writes(
        project_id TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY(project_id,key));",
    )?;
    Ok(())
}

/// A deleted Agent's turn records and receipts go with it. Its sections
/// stay, owned by a deleted Agent, for another Agent of the Project to claim.
pub(crate) fn delete_agent(db: &Connection, id: &str) -> Result<()> {
    db.execute("DELETE FROM project_brief_turns WHERE agent_id=?1", [id])?;
    db.execute("DELETE FROM project_brief_receipts WHERE agent_id=?1", [id])?;
    Ok(())
}

/// The Project whose Brief this Agent may edit: Some while it belongs to a
/// Project that is not archived and the user chose it as a content editor.
pub fn agent_edits_brief(store: &Store, agent_id: &str) -> Result<Option<String>> {
    let db = store.db.read()?;
    let Some(project) = crate::projects::agent_project(&db, agent_id)? else { return Ok(None) };
    Ok(match crate::projects::project_labels(&db)?.get(&project) {
        Some((_, false)) if editors::can_edit(store, &db, &project, agent_id)? => Some(project),
        _ => None,
    })
}

/// What a Home content editor is told beside an outcome: where it goes
/// (`outcome_hint`), and how the user prefers results presented when they
/// said so (`presentation`, T-175). Advice only.
pub struct HomeAdvice {
    pub hint: &'static str,
    pub preference: Option<String>,
}

impl HomeAdvice {
    fn read(db: &Connection) -> Result<Self> {
        Ok(Self { hint: outcome_hint(), preference: presentation::for_agents(db)? })
    }

    /// Sets `homeHint`, and `homePreference` when the user has one.
    pub fn apply(&self, value: &mut Value) {
        value["homeHint"] = self.hint.into();
        if let Some(preference) = &self.preference {
            value["homePreference"] = preference.as_str().into();
        }
    }

    /// The same advice as lines appended to a message.
    pub fn lines(&self) -> String {
        let mut lines = format!("\n{}", self.hint);
        if let Some(preference) = &self.preference {
            lines.push('\n');
            lines.push_str(preference);
        }
        lines
    }
}

/// The Home advice for an Agent that may edit the Brief of this task's
/// Project; None for anyone else, Ask-only members included.
pub fn home_hint(store: &Store, db: &Connection, task_id: &str, agent: &str) -> Result<Option<HomeAdvice>> {
    Ok(match crate::projects::task_projects(db, &[task_id])?.get(task_id) {
        Some(project) if editors::can_edit(store, db, project, agent)? => Some(HomeAdvice::read(db)?),
        _ => None,
    })
}

/// The Home advice for an Agent that may edit its own Project's Brief.
pub fn own_home_hint(store: &Store, db: &Connection, agent: &str) -> Result<Option<HomeAdvice>> {
    Ok(match crate::projects::agent_project(db, agent)? {
        Some(project) if editors::can_edit(store, db, &project, agent)? => Some(HomeAdvice::read(db)?),
        _ => None,
    })
}

/// The Project whose Brief this Agent must update before each Turn ends:
/// none (T-154). An editor updates its sections when something changed,
/// and no Turn is held or reminded for want of an update; the turn-end
/// check (brief_turns) and the Claude Stop hook therefore never act.
pub fn agent_must_update_brief(_store: &Store, _agent_id: &str) -> Result<Option<String>> {
    Ok(None)
}

/// The kind of the receipt Core gave this Turn: "updated" if any accepted
/// update changed the Brief, else "noChange"; None without one.
pub fn turn_receipt(store: &Store, agent_id: &str, turn_id: &str) -> Result<Option<String>> {
    Ok(store.db.read()?.query_row(
        "SELECT kind FROM project_brief_receipts WHERE agent_id=?1 AND turn_id=?2
         ORDER BY kind='updated' DESC LIMIT 1",
        params![agent_id, turn_id],
        |r| r.get(0),
    ).optional()?)
}

/// Records how a Turn ended for its Brief. False, and nothing changed, if
/// its outcome is already final (anything but `reminded`). Each `reminded`
/// counts one reminder.
pub fn record_turn_outcome(store: &Store, agent_id: &str, turn_id: &str, project_id: &str, outcome: &str) -> Result<bool> {
    ensure!(OUTCOMES.contains(&outcome), "unknown Brief turn outcome {outcome}");
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    let previous: Option<String> = tx.query_row(
        "SELECT outcome FROM project_brief_turns WHERE agent_id=?1 AND turn_id=?2",
        params![agent_id, turn_id],
        |r| r.get(0),
    ).optional()?;
    let reminded = i64::from(outcome == "reminded");
    match previous.as_deref() {
        Some(previous) if previous != "reminded" => return Ok(false),
        Some(_) => tx.execute(
            "UPDATE project_brief_turns SET outcome=?3, reminders=reminders+?4, updated_at=?5, project_id=?6
             WHERE agent_id=?1 AND turn_id=?2",
            params![agent_id, turn_id, outcome, reminded, now(), project_id],
        )?,
        None => tx.execute(
            "INSERT INTO project_brief_turns(agent_id,turn_id,project_id,outcome,reminders,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6)",
            params![agent_id, turn_id, project_id, outcome, reminded, now()],
        )?,
    };
    tx.commit()?;
    Ok(true)
}

/// The Turn's recorded outcome and how many reminders it had.
pub fn turn_outcome(store: &Store, agent_id: &str, turn_id: &str) -> Result<Option<(String, u32)>> {
    Ok(store.db.read()?.query_row(
        "SELECT outcome,reminders FROM project_brief_turns WHERE agent_id=?1 AND turn_id=?2",
        params![agent_id, turn_id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    ).optional()?)
}

/// Home's routes: /api/home, /api/projects/{id}/brief/*, /api/brief-cache.
pub fn router() -> axum::Router<Arc<Workspace>> {
    http::routes()
}

/// Tells clients a Brief (or the Project order) changed.
pub(crate) fn announce(ws: &Workspace, project: Option<&str>) {
    let _ = ws.changes.send(json!({"type":"workspace.changed","scope":"brief","projectId":project}));
}

/// An Ask in Home's Needs you, as push notifications name it (T-200): never its text.
pub(crate) struct OpenAsk {
    pub project: String,
    pub key: String,
    pub owner_id: String,
    pub owner_name: String,
    pub since: String,
}

/// The Asks Home lists in Needs you: open, of a Project that exists, and not
/// deferred until later.
pub(crate) fn open_asks(store: &Store) -> Result<Vec<OpenAsk>> {
    let now = chrono::Utc::now();
    let db = store.db.read()?;
    let mut query = db.prepare(
        "SELECT project_id,key,owner_id,owner_name,COALESCE(ask_since,updated_at),deferred_until FROM project_brief_sections
         WHERE live=1 AND kind='ask' AND ask_state='open' AND project_id IN (SELECT id FROM projects) ORDER BY seq")?;
    let rows = query.query_map([], |r| Ok((OpenAsk {
        project: r.get(0)?, key: r.get(1)?, owner_id: r.get(2)?, owner_name: r.get(3)?, since: r.get(4)?,
    }, r.get::<_, Option<String>>(5)?)))?;
    let mut asks = Vec::new();
    for row in rows {
        let (ask, deferred) = row?;
        let later = deferred.as_deref().and_then(|at| chrono::DateTime::parse_from_rfc3339(at).ok()).is_some_and(|until| until > now);
        if !later {
            asks.push(ask);
        }
    }
    Ok(asks)
}

/// brief_* operations from Workspace::collaboration_call. brief_update
/// arrives here only from callers without structured errors; MCP calls
/// `update_tool` directly (see collaboration_mcp).
pub async fn call(ws: Arc<Workspace>, actor: Option<String>, operation: String, input: Value) -> Result<Value> {
    ensure!(input.is_object(), "invalid_input: expected an object");
    match operation.as_str() {
        "brief_get" => ws.stored(move |store| get(store, actor.as_deref(), &input)).await,
        "brief_guide" => guide(&input),
        "brief_update" => {
            let actor = actor.context("agent_only: brief_update is for Agents; the user acts through Home")?;
            match update_tool(&ws, &actor, input).await? {
                Ok(accepted) => Ok(accepted),
                Err(rejected) => bail!("{rejected}"),
            }
        }
        _ => bail!("unknown_operation: {operation}"),
    }
}

/// `brief_update` for the authenticated Agent `actor`. Ok(Err(..)) is a
/// rejection the Agent can fix; Err is everything that is not its update's
/// fault (an unavailable validator, a store failure).
pub(crate) async fn update_tool(ws: &Arc<Workspace>, actor: &str, input: Value) -> Result<Result<Value, Value>> {
    let permit = ws.admission.enter_completion()?;
    let (ws, actor) = (ws.clone(), actor.to_owned());
    // MCP requests can be dropped mid-call; the update and its receipt still
    // complete together.
    tokio::spawn(async move {
        let _permit = permit;
        let checker = update::Checker::Node(ws.results.clone());
        update::update(&ws, &checker, &actor, input).await
    })
    .await?
}

/// How much of a reply `you.repliedAsks` repeats; the section carries all of it.
const REPLY_PREVIEW: usize = 300;

/// One of your asks the user has answered and you have not resolved, in
/// short: the same row brief_get lists among the sections.
fn replied_ask(row: &sections::Row) -> Value {
    let text = row.reply_text.as_deref().unwrap_or_default();
    let mut reply: String = text.chars().take(REPLY_PREVIEW).collect();
    if reply.len() < text.len() {
        reply.push('…');
    }
    let time = |at: &str| chrono::DateTime::parse_from_rfc3339(at).ok();
    let updated = match (row.replied_at.as_deref().and_then(time), time(&row.updated_at)) {
        (Some(replied), Some(updated)) => updated > replied,
        _ => false,
    };
    json!({"key":row.key,"title":row.data["title"],"repliedAt":row.replied_at,"reply":reply,"updatedSinceReply":updated})
}

/// At most this many keys in one brief_get: the topics and their subs.
const MAX_KEYS: usize = 60;

/// `brief_get`: the live Brief of the caller's Project, or of `projectId`.
fn get(store: &Store, actor: Option<&str>, input: &Value) -> Result<Value> {
    if let Some(key) = input.as_object().and_then(|o| o.keys().find(|key| !matches!(key.as_str(), "projectId" | "keys"))) {
        bail!("invalid_input: unknown argument {key}");
    }
    // None: every section in full. Some: an index of all, and these in full.
    let keys: Option<Vec<String>> = match input.get("keys") {
        None | Some(Value::Null) => None,
        Some(Value::Array(keys)) if keys.len() <= MAX_KEYS => Some(keys.iter().map(|key| match key.as_str() {
            Some(key) if !key.is_empty() && key.len() <= 97 => Ok(key.to_owned()),
            _ => bail!("invalid_input: keys are section keys such as plan or plan/review"),
        }).collect::<Result<_>>()?),
        Some(_) => bail!("invalid_input: keys is a list of at most {MAX_KEYS} section keys; [] lists sections without bodies"),
    };
    let db = store.db.read()?;
    let own = match actor {
        Some(actor) => crate::projects::agent_project(&db, actor)?,
        None => None,
    };
    let project = match input.get("projectId") {
        None | Some(Value::Null) => own.clone().context(
            "not_in_project: you belong to no Project, so you keep no Brief; pass projectId to read another Project's",
        )?,
        Some(Value::String(id)) => id.clone(),
        _ => bail!("invalid_input: projectId must be a string"),
    };
    let labels = crate::projects::project_labels(&db)?;
    let (name, _) = labels.get(&project).context("project_not_found: no Project has this ID")?;
    // With keys, every section is read without its body (the index) and
    // only the named ones in full.
    let rows = match &keys {
        None => sections::live(&db, &project)?,
        Some(_) => sections::live_index(&db, &project)?,
    };
    let full = match &keys {
        None => None,
        Some(keys) => Some(sections::live_keys(&db, &project, keys)?),
    };
    let seen = sections::seen(&db, &project)?;
    let mut owners = sections::Owners::default();
    let mut refs = refs::Refs::new(store, &db);
    let at = chrono::Utc::now();
    let mut listed = vec![];
    for row in full.as_ref().unwrap_or(&rows) {
        let owner = owners.get(store, &db, row)?;
        listed.push(sections::section_json(row, &owner, seen.get(&row.key), refs.of(&row.data["body"]), at));
    }
    let you = actor.map(|actor| -> Result<Value> {
        let owned: Vec<&str> = rows.iter().filter(|row| row.owner_id == actor).map(|row| row.key.as_str()).collect();
        let open = rows.iter().filter(|row| row.owner_id == actor && row.unresolved_ask()).count();
        let replied: Vec<Value> = rows.iter().filter(|row| row.owner_id == actor && row.replied_ask()).map(replied_ask).collect();
        // Advice, never a requirement: a stale status is refreshed when
        // there are new facts, not to make it look current.
        let stale: Vec<&str> = rows.iter()
            .filter(|row| row.owner_id == actor && row.kind == "status" && sections::stale(&row.data["status"], at))
            .map(|row| row.key.as_str()).collect();
        let can_edit = editors::can_edit(store, &db, &project, actor)?;
        let mut you = json!({"agentId":actor,"ownsKeys":owned,"openAsks":open,"repliedAsks":replied,"staleStatus":stale,
            "capabilities":{"editContent":can_edit,"requiresTurnUpdate":false,
                "writeOwnAsk":own.as_deref() == Some(project.as_str()) && !crate::projects::is_archived(&db, &project)?
                    && store.brief_in(&db, actor)?.is_some_and(|a| a.agent.closed_at.is_none())}});
        if can_edit {
            HomeAdvice::read(&db)?.apply(&mut you);
        }
        Ok(you)
    }).transpose()?;
    let mut brief = json!({"projectId":project,"projectName":name,"version":sections::brief_version(&db, &project)?,
        "sections":listed,"you":you,"contentEditors":editors::policy(&db, &project)?,"limits":limits()});
    if let Some(keys) = &keys {
        let mut index = Vec::with_capacity(rows.len());
        for row in &rows {
            index.push(sections::index_json(row, &owners.get(store, &db, row)?, seen.get(&row.key), at));
        }
        let missing: Vec<&String> = keys.iter().filter(|key| !rows.iter().any(|row| &row.key == *key)).collect();
        brief["index"] = index.into();
        brief["missingKeys"] = json!(missing);
    }
    Ok(brief)
}
