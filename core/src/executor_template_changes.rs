//! A lead's change to the Workspace's executor templates (YN-24;
//! docs/executor-model.md). A lead of a Project changes one or more
//! templates with `executor_templates_change`, against the list's version it
//! read, with a reason. It is saved at once and no one approves it (the
//! user's decision, as for the handover since YN-2 S3); the Project's other
//! leads get one short mail.
//!
//! Each save of the list, the user's in Settings too, is a row of its
//! history: the version it made, who, when, why, and each template it
//! changed as it was and as it is. A lead's change applies while each
//! template it changes is as it was at the version the lead read: a save of
//! another template since doesn't stop it. The user's save stays checked
//! against the whole list, and a conflict names the lead's change.
use crate::{
    executor_templates::{confirmed, list_at, parse_one, write_list, Template, Templates, KEY, MAX_TEMPLATES},
    model::now,
    store::Store,
    workspace::Workspace,
};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::Arc};

pub(crate) const TOOL: &str = "executor_templates_change";
/// A reason, in bytes.
const MAX_REASON: usize = 1000;
const NOT_LEAD: &str = "not_lead: only a lead of a Project changes the executor templates; tell a lead or the user what should change";

/// Idempotent, on every open: one row per save, by the list version it made.
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS executor_template_changes(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            version INTEGER NOT NULL, at TEXT NOT NULL,
            author_kind TEXT NOT NULL CHECK(author_kind IN ('user','agent')),
            author_id TEXT, author_name TEXT NOT NULL, project_id TEXT,
            reason TEXT, request_id TEXT, requested TEXT, changes TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS executor_template_changes_version ON executor_template_changes(version);
        CREATE UNIQUE INDEX IF NOT EXISTS executor_template_changes_request
            ON executor_template_changes(author_id, request_id) WHERE request_id IS NOT NULL;",
    )?;
    Ok(())
}

/// Who saved the list.
pub(crate) enum Author<'a> {
    User,
    /// A lead, its Project, the request and the reason it gave.
    Lead { id: &'a str, name: &'a str, project: &'a str, request: &'a Request },
}

/// Each template `templates` changes from `current`, as it was and as it is
/// (null for one added or removed), in the list's order, removed ones last.
fn diff(current: &Templates, templates: &[Template]) -> Result<Vec<Value>> {
    let mut changes = vec![];
    for template in templates {
        let before = current.templates.iter().find(|t| t.id == template.id).map(serde_json::to_value).transpose()?;
        let after = Some(serde_json::to_value(template)?);
        if before != after {
            changes.push(json!({"id": template.id, "label": template.label, "before": before, "after": after}));
        }
    }
    for gone in current.templates.iter().filter(|t| !templates.iter().any(|kept| kept.id == t.id)) {
        changes.push(json!({"id": gone.id, "label": gone.label, "before": gone, "after": null}));
    }
    Ok(changes)
}

/// The history row of the save that wrote `templates` over `current`, as
/// version `current.version + 1`, in its transaction.
pub(crate) fn record(tx: &Connection, current: &Templates, templates: &[Template], author: Author) -> Result<Vec<Value>> {
    let changes = diff(current, templates)?;
    let (kind, id, name, project, reason, request, requested) = match author {
        Author::User => ("user", None, "You", None, None, None, None),
        Author::Lead { id, name, project, request } =>
            ("agent", Some(id), name, Some(project), Some(request.reason.as_str()), Some(request.id.as_str()), Some(request.requested())),
    };
    tx.execute(
        "INSERT INTO executor_template_changes(version, at, author_kind, author_id, author_name, project_id, reason, request_id, requested, changes)
         VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![current.version + 1, now(), kind, id, name, project, reason, request, requested, Value::Array(changes.clone()).to_string()],
    )?;
    Ok(changes)
}

/// What a change does to its template.
fn kind(change: &Value) -> &'static str {
    match (change["before"].is_null(), change["after"].is_null()) {
        (true, _) => "add",
        (_, true) => "remove",
        _ => "change",
    }
}

fn quoted(labels: impl IntoIterator<Item = String>) -> String {
    labels.into_iter().map(|l| format!("“{l}”")).collect::<Vec<_>>().join(", ")
}

/// A save as the history keeps it.
struct Saved {
    version: i64,
    at: String,
    author_kind: String,
    author_id: Option<String>,
    author_name: String,
    reason: Option<String>,
    requested: Option<String>,
    changes: Vec<Value>,
}

const COLUMNS: &str = "version, at, author_kind, author_id, author_name, reason, requested, changes";

fn row(r: &rusqlite::Row) -> rusqlite::Result<Saved> {
    let changes: String = r.get(7)?;
    Ok(Saved { version: r.get(0)?, at: r.get(1)?, author_kind: r.get(2)?, author_id: r.get(3)?, author_name: r.get(4)?,
        reason: r.get(5)?, requested: r.get(6)?, changes: serde_json::from_str(&changes).unwrap_or_default() })
}

/// The saves after version `read`, oldest first.
fn since(db: &Connection, read: i64) -> Result<Vec<Saved>> {
    let mut query = db.prepare(&format!("SELECT {COLUMNS} FROM executor_template_changes WHERE version>?1 ORDER BY version, id"))?;
    let rows = query.query_map([read], row)?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// The leads' changes after version `read`, for the user's save that
/// conflicts with them: who changed which templates.
pub(crate) fn by_leads_since(db: &Connection, read: i64) -> Result<Option<String>> {
    let said: Vec<String> = since(db, read)?.into_iter().filter(|s| s.author_kind == "agent" && !s.changes.is_empty())
        .map(|s| format!("{} changed {}", s.author_name, quoted(s.changes.iter().map(|c| c["label"].as_str().unwrap_or_default().to_owned()))))
        .collect();
    Ok((!said.is_empty()).then(|| said.join("; ")))
}

/// Who last changed each template, when and why, by its id, as the
/// templates' answer carries it (`lastModified`).
pub(crate) fn last_modified(db: &Connection, templates: &[Template]) -> Result<Value> {
    let mut query = db.prepare(&format!("SELECT {COLUMNS} FROM executor_template_changes ORDER BY version DESC, id DESC LIMIT 1000"))?;
    let mut shown = serde_json::Map::new();
    for saved in query.query_map([], row)? {
        let saved = saved?;
        for change in &saved.changes {
            let id = change["id"].as_str().unwrap_or_default();
            if templates.iter().any(|t| t.id == id) && !shown.contains_key(id) {
                shown.insert(id.to_owned(), json!({"version": saved.version, "at": saved.at, "reason": saved.reason,
                    "by": {"kind": saved.author_kind, "id": saved.author_id, "name": saved.author_name}}));
            }
        }
        if shown.len() == templates.len() {
            break;
        }
    }
    Ok(Value::Object(shown))
}

// ---- The Agent tool ----

pub(crate) fn tool_definition() -> Value {
    json!({"name": TOOL,
        "description": "Change the Workspace's executor templates, against the list's version you read (executor_templates_list with full true gives it and each template as saved), with a reason. For leads of a Project only; executors and other Agents can't. It is saved at once and no one approves it; every dispatch from these templates uses it from then on, and executors already created keep theirs. The Project's other leads get a short mail, and the templates' history keeps who changed each one, when, why, and how it was before. Each change is {op:\"put\", template}: a whole template, with the fields the user's Settings saves, that adds one or replaces the one with its id; or {op:\"remove\", id}. It applies while each template you change is as it was at the version you read; a change to another template since doesn't stop it.",
        "inputSchema": {"type":"object","additionalProperties":false,"required":["requestId","expectedVersion","changes","reason"],
            "properties": {
                "requestId": {"type":"string","maxLength":128},
                "expectedVersion": {"type":"integer","minimum":0,"description":"The templates list's version you read."},
                "changes": {"type":"array","minItems":1,"maxItems":MAX_TEMPLATES,"items":{"type":"object","additionalProperties":false,"required":["op"],
                    "properties":{"op":{"enum":["put","remove"]},"template":{"type":"object"},"id":{"type":"string","maxLength":48}}}},
                "reason": {"type":"string","description":"Why, at most 1,000 bytes; kept in the history with your change."}}}})
}

pub async fn call(ws: Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    ensure!(input.is_object(), "invalid_input: expected an object");
    let actor = actor.context("agent_only: executor_templates_change is for a Project's leads; the user changes templates in Settings → Executor templates")?;
    let permit = ws.admission.enter_work()?;
    // A dropped MCP request still completes the save and its announcement together.
    tokio::spawn(async move {
        let _permit = permit;
        let request = Request::parse(&input)?;
        let (store, lead, retry) = (ws.store.clone(), actor.clone(), request.clone());
        // A retry answers as before; then only a lead goes on.
        if let Some(answer) = crate::db::blocking(move || {
            let db = store.db.read()?;
            match earlier(&db, &lead, &retry)? {
                Some(answer) => Ok(Some(answer)),
                None => who(&db, &lead).map(|_| None),
            }
        }).await? {
            return Ok(answer);
        }
        let current = ws.stored(|s| s.executor_templates()).await?;
        let edits = changed(&ws, &request, &current).await?;
        let store = ws.store.clone();
        let answer = crate::db::blocking(move || save(&store, &actor, &request, edits)).await?;
        if answer.1 {
            let _ = ws.changes.send(json!({"executorTemplates": true}));
            ws.collaboration_wakeup.notify_one();
            let _ = ws.changes.send(json!({"collaboration":true,"tasks":false}));
        }
        Ok(answer.0)
    }).await.context("The executor template change ended unexpectedly")?
}

#[derive(Clone)]
pub(crate) struct Request {
    id: String,
    expected: i64,
    changes: Vec<Value>,
    reason: String,
}

impl Request {
    fn parse(input: &Value) -> Result<Self> {
        if let Some(key) = input.as_object().into_iter().flat_map(|o| o.keys())
            .find(|k| !["requestId", "expectedVersion", "changes", "reason"].contains(&k.as_str())) {
            bail!("invalid_input: unknown field {key}");
        }
        let id = input["requestId"].as_str().filter(|r| !r.is_empty() && r.len() <= 128)
            .context("invalid_input: requestId is required, at most 128 characters")?.to_owned();
        let expected = input["expectedVersion"].as_i64().context("invalid_input: expectedVersion is required")?;
        let changes = input["changes"].as_array().filter(|c| !c.is_empty() && c.len() <= MAX_TEMPLATES)
            .context("invalid_input: changes is a list of 1 to 50 changes")?.clone();
        let reason = input["reason"].as_str().map(str::trim).filter(|r| !r.is_empty())
            .context("invalid_input: reason is required: say why, for the user")?.to_owned();
        ensure!(reason.len() <= MAX_REASON && !reason.chars().any(|c| c.is_control() && c != '\n'),
            "invalid_input: a reason is at most {MAX_REASON} bytes of text");
        Ok(Self { id, expected, changes, reason })
    }

    fn requested(&self) -> String {
        Value::Array(self.changes.clone()).to_string()
    }
}

/// The Project `actor` leads: its own, not archived.
fn who(db: &Connection, actor: &str) -> Result<String> {
    let project: String = db.query_row("SELECT project_id FROM project_agents WHERE agent_id=?1", [actor], |r| r.get(0))
        .optional()?.context(NOT_LEAD)?;
    ensure!(crate::agent_roles::leads(db, actor, &project)?, NOT_LEAD);
    crate::projects::ensure_assignable(db, &project)?;
    Ok(project)
}

fn answer(version: i64, changes: &[Value]) -> Value {
    let templates: Vec<Value> = changes.iter().map(|c| json!({"id": c["id"], "label": c["label"], "change": kind(c)})).collect();
    json!({"outcome": "saved", "version": version, "templates": templates,
        "saved": "Saved. Dispatches from these templates use it from now on; executors already created keep theirs. The history keeps your name and reason with each template you changed."})
}

/// The same answer for a retry with the same requestId.
fn earlier(db: &Connection, actor: &str, request: &Request) -> Result<Option<Value>> {
    let found: Option<Saved> = db.query_row(
        &format!("SELECT {COLUMNS} FROM executor_template_changes WHERE author_id=?1 AND request_id=?2"),
        params![actor, request.id], row).optional()?;
    let Some(found) = found else { return Ok(None) };
    let requested = found.requested.as_deref().and_then(|r| serde_json::from_str::<Value>(r).ok());
    ensure!(requested == Some(Value::Array(request.changes.clone())) && found.reason.as_deref() == Some(request.reason.as_str()),
        "idempotency_conflict: requestId already has a different payload");
    Ok(Some(answer(found.version, &found.changes)))
}

/// A request's changes, each checked as the user's save checks a template,
/// on the list as read.
struct Edits {
    puts: Vec<Template>,
    removed: Vec<String>,
}

async fn changed(ws: &Arc<Workspace>, request: &Request, current: &Templates) -> Result<Edits> {
    let opencode = crate::opencode_agent::enabled();
    let stored = current.stored_templates();
    let mut seen = BTreeSet::new();
    let mut puts: Vec<Template> = vec![];
    let mut removed: Vec<String> = vec![];
    for change in &request.changes {
        let Some(object) = change.as_object() else { bail!("invalid_input: a change is an object") };
        if let Some(key) = object.keys().find(|k| !["op", "template", "id"].contains(&k.as_str())) {
            bail!("invalid_input: unknown field {key} in a change");
        }
        let id = match change["op"].as_str() {
            Some("put") => {
                ensure!(change.get("id").is_none(), "invalid_input: a put names its template's id in the template");
                let template = parse_one(change.get("template").context("invalid_input: a put carries the whole template")?,
                    opencode, &current.templates)?;
                let id = template.id.clone();
                puts.push(template);
                id
            }
            Some("remove") => {
                ensure!(change.get("template").is_none(), "invalid_input: a remove names only the id");
                let id = change["id"].as_str().context("invalid_input: a remove names the template's id")?.to_owned();
                ensure!(current.templates.iter().any(|t| t.id == id), "unknown_template: there is no template {id}; read the templates again");
                removed.push(id.clone());
                id
            }
            _ => bail!("invalid_input: a change's op is put or remove"),
        };
        ensure!(seen.insert(id.clone()), "invalid_input: change each template once; {id} is named twice");
        // A later Core's template is changed there, never here.
        ensure!(current.templates.iter().any(|t| t.id == id) || !stored.iter().any(|t| t["id"] == id.as_str()),
            "later_template: {id} was saved by a newer Core; change it there");
    }
    confirmed(ws, &mut puts, &current.templates).await?;
    for template in &puts {
        ensure!(!current.templates.contains(template), "nothing_changed: {} is already as given", template.id);
    }
    Ok(Edits { puts, removed })
}

/// The templates a request changes, by id.
fn named(request: &Request) -> BTreeSet<String> {
    request.changes.iter().filter_map(|c| c["template"]["id"].as_str().or(c["id"].as_str()).map(str::to_owned)).collect()
}

/// The lead `actor`'s save, in one transaction with its checks. Each
/// template it changes must be as it was at the version the lead read; the
/// changes are then made on the list as it is now, the others as they are.
/// Returns the answer and whether anything was written.
fn save(store: &Store, actor: &str, request: &Request, edits: Edits) -> Result<(Value, bool)> {
    let mut writer = store.db.write()?;
    let tx = writer.transaction()?;
    if let Some(answer) = earlier(&tx, actor, request)? {
        return Ok((answer, false));
    }
    let project = who(&tx, actor)?;
    let current = list_at(&tx, KEY)?;
    unchanged_since(&tx, request, current.version)?;
    let mut templates: Vec<Template> = current.templates.iter().filter(|t| !edits.removed.contains(&t.id)).cloned().collect();
    for template in edits.puts {
        match templates.iter().position(|t| t.id == template.id) {
            Some(at) => templates[at] = template,
            None => templates.push(template),
        }
    }
    let most = MAX_TEMPLATES.max(current.templates.len());
    ensure!(templates.len() <= most, "At most {most} templates");
    let name = crate::collaboration_store::agent_actor(store, &tx, actor)?.name;
    write_list(&tx, &current, &templates)?;
    let changes = record(&tx, &current, &templates, Author::Lead { id: actor, name: &name, project: &project, request })?;
    let version = current.version + 1;
    tell_leads(&tx, actor, &name, &project, version, &changes, &request.reason)?;
    tx.commit()?;
    Ok((answer(version, &changes), true))
}

/// Whether the templates `request` changes are as they were at the version
/// it read: every save since is in the history, and none changed one of
/// them. A save the history doesn't have (an older Core's) is a conflict
/// for the whole list.
fn unchanged_since(db: &Connection, request: &Request, version: i64) -> Result<()> {
    let again = |current: i64| format!("read the templates again and change them on version {current}");
    ensure!(request.expected <= version, "version_conflict: the executor templates are at version {version}, not {}; {}",
        request.expected, again(version));
    let saves = since(db, request.expected)?;
    let versions: BTreeSet<i64> = saves.iter().map(|s| s.version).collect();
    ensure!(versions.len() as i64 == version - request.expected && saves.len() == versions.len(),
        "version_conflict: the executor templates are at version {version}, not {}; {}", request.expected, again(version));
    let ids = named(request);
    let ours = |c: &&Value| c["id"].as_str().is_some_and(|id| ids.contains(id));
    let said: Vec<String> = saves.iter().filter(|s| s.changes.iter().any(|c| ours(&c)))
        .map(|s| format!("{} changed {} at version {}", s.author_name,
            quoted(s.changes.iter().filter(ours).map(|c| c["label"].as_str().unwrap_or_default().to_owned())), s.version))
        .collect();
    ensure!(said.is_empty(), "version_conflict: {} after version {}; {}", said.join("; "), request.expected, again(version));
    Ok(())
}

/// One short mail to each other open lead of the Project, in the save's
/// transaction.
fn tell_leads(tx: &Connection, actor: &str, name: &str, project: &str, version: i64, changes: &[Value], reason: &str) -> Result<()> {
    let leads = crate::agent_roles::leads_in(tx, project)?.lead_agent_ids;
    let labels = quoted(changes.iter().map(|c| c["label"].as_str().unwrap_or_default().to_owned()));
    for lead in leads.iter().filter(|l| l.as_str() != actor) {
        let open: Option<String> = tx.query_row(
            "SELECT json_extract(data,'$.name') FROM agents WHERE id=?1 AND json_extract(data,'$.agent.closedAt') IS NULL",
            [lead], |r| r.get(0)).optional()?.flatten();
        let Some(recipient) = open else { continue };
        let id = uuid::Uuid::new_v4().to_string();
        crate::collaboration_store::insert_message(tx, json!({"id":id,"seq":0,
            "sender":{"kind":"system","id":"core","name":"Yuzuno Core"},
            "recipient":{"kind":"agent","id":lead,"name":recipient},
            "body":format!("{name} changed the executor templates {labels}; they are at version {version} now. Their reason: {reason}"),
            "taskId":null,"replyTo":null,"threadId":id,"createdAt":now(),"priority":"normal",
            "source":{"executorTemplates":version},
            "metadata":{"kind":"executorTemplates","status":"changed","projectId":project,"version":version}}))?;
    }
    Ok(())
}

#[cfg(test)]
#[path = "executor_template_changes_tests.rs"]
mod tests;
