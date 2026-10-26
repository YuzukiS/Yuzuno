//! Explicit shared work and durable correspondence. Harness events never write
//! these tables: a task is a goal, not a transcript or a native plan step.
use crate::{
    model::now,
    store::Store,
};
use anyhow::{bail, ensure, Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub(crate) const STATUSES: [&str; 6] = ["todo", "doing", "blocked", "review", "done", "cancelled"];

mod result_dispatch;
mod dispatch_materials;
mod current;
mod compact;
use result_dispatch::TaskDispatch;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskActor {
    pub kind: String,
    pub id: String,
    pub name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedTask {
    pub id: String,
    pub seq: i64,
    pub title: String,
    pub description: String,
    pub status: String,
    pub assignee_agent_id: Option<String>,
    pub assignee: Option<TaskActor>,
    pub progress: String,
    pub blocker: String,
    pub result: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dispatch: Option<TaskDispatch>,
    pub archived_at: Option<String>,
    pub version: i64,
    pub created_at: String,
    pub created_by: TaskActor,
    pub updated_at: String,
    pub updated_by: TaskActor,
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    // Actor names are snapshots; deleting an Agent must not erase shared work.
    // In particular, none of these tables references agents with ON DELETE.
    db.execute_batch("CREATE TABLE IF NOT EXISTS collaboration_tasks(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        version INTEGER NOT NULL, data TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS collaboration_task_activity(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS collaboration_activity_task ON collaboration_task_activity(task_id,seq);
        CREATE INDEX IF NOT EXISTS collaboration_activity_materials ON collaboration_task_activity(task_id,json_extract(data,'$.dispatch.id'),seq)
        WHERE json_extract(data,'$.kind')='dispatched' AND json_type(data,'$.materials')='object';
        CREATE INDEX IF NOT EXISTS collaboration_activity_registration ON collaboration_task_activity(task_id,seq)
        WHERE json_extract(data,'$.kind') IN ('created','updated') AND json_type(data,'$.changes.materials') IS NOT NULL;
        CREATE INDEX IF NOT EXISTS collaboration_activity_dispatched ON collaboration_task_activity(task_id,seq)
        WHERE json_extract(data,'$.kind')='dispatched';
        CREATE INDEX IF NOT EXISTS collaboration_activity_dispatch_end ON collaboration_task_activity(task_id,seq)
        WHERE json_extract(data,'$.kind') IN ('updated','claimed') AND (json_type(data,'$.changes.archived') IS NOT NULL
        OR json_extract(data,'$.changes.status')='cancelled' OR json_type(data,'$.changes.assigneeAgentId') IS NOT NULL);
        CREATE TABLE IF NOT EXISTS collaboration_messages(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        sender_id TEXT NOT NULL, recipient_id TEXT NOT NULL, data TEXT NOT NULL,
        delivery_state TEXT NOT NULL DEFAULT 'pending', delivery_detail TEXT NOT NULL DEFAULT '{}');
        CREATE INDEX IF NOT EXISTS collaboration_messages_recipient ON collaboration_messages(recipient_id,seq);
        CREATE INDEX IF NOT EXISTS collaboration_messages_delivery ON collaboration_messages(delivery_state,recipient_id,seq);
        CREATE INDEX IF NOT EXISTS collaboration_messages_client ON collaboration_messages(recipient_id,json_extract(delivery_detail,'$.clientMessageId'));
        CREATE INDEX IF NOT EXISTS collaboration_messages_turn ON collaboration_messages(recipient_id,json_extract(delivery_detail,'$.turnId'));
        CREATE INDEX IF NOT EXISTS collaboration_messages_update_wait ON collaboration_messages(json_extract(data,'$.metadata.operationId')) WHERE json_extract(data,'$.metadata.kind')='update_wait';
        CREATE TABLE IF NOT EXISTS collaboration_message_reads(
        message_seq INTEGER NOT NULL, reader_id TEXT NOT NULL, read_at TEXT NOT NULL,
        PRIMARY KEY(message_seq,reader_id));
        CREATE TABLE IF NOT EXISTS collaboration_requests(
        actor TEXT NOT NULL, operation TEXT NOT NULL, request_id TEXT NOT NULL,
        input_json TEXT NOT NULL, response_json TEXT NOT NULL,
        PRIMARY KEY(actor,operation,request_id));")?;
    // A restart cannot tell whether the Harness accepted an in-flight nudge.
    db.execute(
        "UPDATE collaboration_messages SET delivery_state='uncertain',
        delivery_detail=json_patch(delivery_detail,?1) WHERE delivery_state='sending'",
        [json!({"reason":"core_restarted","at":now()}).to_string()],
    )?;
    Ok(())
}

impl Store {
    /// GUI and MCP share exactly the same transaction boundary. MCP supplies a
    /// server-bound actor, never a model-provided sender or author field.
    pub fn collaboration_call(
        &self,
        actor: Option<&str>,
        operation: &str,
        input: Value,
    ) -> Result<Value> {
        self.collaboration_call_from(actor, None, operation, input)
    }

    /// As collaboration_call; a GUI call (`actor` None) records `gui_source`
    /// as its activity's source, e.g. the proposal the user confirmed.
    pub(crate) fn collaboration_call_from(
        &self,
        actor: Option<&str>,
        gui_source: Option<Value>,
        operation: &str,
        input: Value,
    ) -> Result<Value> {
        ensure!(input.is_object(), "invalid_input: expected an object");
        // Listing and reading change nothing (only an Agent's own peer_read
        // records what it read), so they use a reader's snapshot and never wait
        // for the writer. Everything else is one IMMEDIATE write transaction.
        let read_only = matches!(operation, "peers_list" | "projects_list" | "task_list" | "task_get" | "delivery_get")
            || (operation == "peer_read" && actor.is_none());
        let reader = if read_only { Some(self.db.read()?) } else { None };
        let mut writer = if read_only { None } else { Some(self.db.write()?) };
        let transaction = match writer.as_mut() { Some(writer) => Some(writer.transaction()?), None => None };
        let tx: &Connection = match &transaction { Some(transaction) => transaction, None => reader.as_deref().unwrap() };
        // All stored relationships and receipts retain the original UUID. The
        // public reference is the durable SQLite sequence, never a second task.
        let input = normalize_task_input(&tx, operation, input)?;
        let (author, mut source) = actor_context(self, &tx, actor)?;
        if let (None, Some(gui_source)) = (actor, gui_source) {
            source = gui_source;
        }
        let mutation = matches!(
            operation,
            "peer_send"
                | "task_create"
                | "task_update"
                | "task_claim"
                | "task_comment"
                | "task_submit_result"
                | "task_dispatch" | "delivery_enable" | "delivery_continue" | "delivery_stop"
        );
        let actor_key = actor
            .map(|id| format!("agent:{id}"))
            .unwrap_or_else(|| "user".into());
        let request_id = if mutation {
            Some(required_text(&input, "requestId", 128)?)
        } else {
            None
        };
        if let Some(id) = request_id.as_deref() {
            let previous: Option<(String, String)> = tx.query_row(
                "SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation=?2 AND request_id=?3",
                params![actor_key, operation, id], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            if let Some((payload, response)) = previous {
                ensure!(
                    normalize_task_input(&tx, operation, serde_json::from_str(&payload)?)? == input,
                    "idempotency_conflict: requestId already has a different payload"
                );
                // Receipts written by older builds may still contain UUIDs.
                // Project them at the same boundary as fresh responses.
                return public_response(&tx, serde_json::from_str(&response)?);
            }
        }
        let output = match operation {
            "peers_list" => peers_list(self, &tx, &input)?,
            "projects_list" => {
                allowed(&input, &[])?;
                json!({"projects": crate::projects::summaries(&tx)?})
            }
            "peer_send" => {
                allowed(
                    &input,
                    &[
                        "requestId",
                        "toAgentId",
                        "body",
                        "taskId",
                        "replyTo",
                        "priority",
                    ],
                )?;
                json!({"message": create_message(self, &tx, &author, &source, &input)?})
            }
            "peer_read" => peer_read(&tx, actor, &input)?,
            "task_list" => task_list(&tx, &input)?,
            "task_get" => task_get(&tx, &input)?,
            "task_create" => task_create(self, &tx, &author, &source, &input)?,
            "task_update" => task_update(self, &tx, &author, &source, &input)?,
            "task_claim" => task_claim(&tx, &author, &source, &input)?,
            "task_comment" => task_comment(&tx, &author, &source, &input)?,
            "task_submit_result" => task_submit_result(self, &tx, &author, &source, &input)?,
            "task_dispatch" => task_dispatch(self, &tx, &author, &source, &input)?,
            "delivery_get" | "delivery_enable" | "delivery_continue" | "delivery_stop" => crate::delivery::store::call(self,&tx,&author,&source,operation,&input)?,
            _ => bail!("unknown_operation: {operation}"),
        };
        // Attach before the receipt is stored: a retry returns the project the
        // task had in the first answer instead of recomputing a default.
        let mut output = output;
        attach_task_projects(&tx, &mut output)?;
        if let Some(id) = request_id {
            tx.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,?2,?3,?4,?5)",
                params![actor_key, operation, id, input.to_string(), output.to_string()])?;
        }
        let output = public_response(&tx, output)?;
        if let Some(transaction) = transaction { transaction.commit()?; }
        Ok(output)
    }

    /// Separate priority batches keep a working Agent's urgent notification from
    /// reserving or reading normal mail that should wait for a turn boundary.
    pub fn pending_peer_deliveries(&self) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q = db.prepare("SELECT recipient_id,MAX(seq),COUNT(*),
            (SELECT MIN(older.seq)-1 FROM collaboration_messages older
             WHERE older.recipient_id=m.recipient_id
               AND COALESCE(json_extract(older.data,'$.priority'),'normal')=COALESCE(json_extract(m.data,'$.priority'),'normal')
               AND NOT EXISTS(
               SELECT 1 FROM collaboration_message_reads seen WHERE seen.message_seq=older.seq AND seen.reader_id=older.recipient_id))
            ,COALESCE(json_extract(m.data,'$.priority'),'normal') AS priority
            FROM collaboration_messages m
            WHERE delivery_state='pending' AND COALESCE(json_extract(m.data,'$.metadata.kind'),'')!='update_wait'
              AND NOT EXISTS(SELECT 1 FROM collaboration_message_reads r
                WHERE r.message_seq=m.seq AND r.reader_id=m.recipient_id)
            GROUP BY recipient_id,priority ORDER BY CASE priority WHEN 'urgent' THEN 0 ELSE 1 END,MIN(seq)")?;
        let rows = q.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
            ))
        })?;
        let mut batches = Vec::new();
        for row in rows {
            let (id, through, count, after, priority) = row?;
            // The listed view: parsing whole records here, on every wake-up
            // while mail waits, held back every other Agent's events.
            if let Some(brief) = self.brief_in(&db, &id)? {
                if brief.agent.closed_at.is_none() {
                    batches.push(json!({"agentId":id,"priority":priority,"throughSeq":through,"afterSeq":after,"messageCount":count}));
                }
            }
        }
        Ok(batches)
    }

    /// The runtime reserves pending messages before calling a Harness. Finishing
    /// a batch changes only its sending rows, never a previous uncertain outcome.
    pub fn set_peer_delivery(
        &self,
        agent_id: &str,
        through_seq: i64,
        state: &str,
        detail: Value,
    ) -> Result<usize> {
        self.set_peer_delivery_for_priority(agent_id, through_seq, "normal", state, detail)
    }

    pub fn set_peer_delivery_for_priority(
        &self,
        agent_id: &str,
        through_seq: i64,
        priority: &str,
        state: &str,
        detail: Value,
    ) -> Result<usize> {
        ensure!(
            through_seq >= 0,
            "invalid_input: throughSeq must be nonnegative"
        );
        ensure!(
            matches!(priority, "normal" | "urgent"),
            "invalid_input: priority must be normal or urgent"
        );
        let from = match state {
            "sending" => "pending",
            "delivered" | "uncertain" | "error" => "sending",
            "pending" => "error", // explicit retry of a known failure only
            _ => bail!("invalid_input: invalid delivery state"),
        };
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut detail = detail;
        ensure!(detail.is_object(), "invalid_input: delivery detail must be an object");
        if state == "sending" {
            detail["mailbox"] = crate::mailbox_notice::snapshot(&tx, agent_id, through_seq, priority, &detail)?;
        } else {
            detail.as_object_mut().unwrap().remove("mailbox");
        }
        let changed = tx.execute("UPDATE collaboration_messages SET delivery_state=?1,
            delivery_detail=CASE WHEN ?1 IN ('delivered','uncertain','error') THEN json_patch(delivery_detail,?2) ELSE ?2 END
            WHERE recipient_id=?3 AND seq<=?4 AND delivery_state=?5
              AND COALESCE(json_extract(data,'$.priority'),'normal')=?6
              AND COALESCE(json_extract(data,'$.metadata.kind'),'')!='update_wait'
              AND (?1!='sending' OR NOT EXISTS(SELECT 1 FROM collaboration_message_reads r
                WHERE r.message_seq=collaboration_messages.seq AND r.reader_id=collaboration_messages.recipient_id))",
            params![state, detail.to_string(), agent_id, through_seq, from, priority])?;
        tx.commit()?;
        Ok(changed)
    }
}

fn task_number(seq: i64) -> String {
    format!("T-{seq}")
}

/// Accept the stable public number and old UUID clients without duplicating any
/// stored relation. AUTOINCREMENT prevents a deleted/archived number being reused.
pub(crate) fn task_key(db: &Connection, reference: &str) -> Result<(String, i64)> {
    let row = if let Some(number) = reference.strip_prefix("T-") {
        let seq = number
            .parse::<i64>()
            .context("invalid_input: task ID must be T- followed by a positive integer")?;
        ensure!(
            seq > 0 && number == seq.to_string(),
            "invalid_input: use the canonical task ID, for example T-1"
        );
        db.query_row(
            "SELECT id,seq FROM collaboration_tasks WHERE seq=?1",
            [seq],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
    } else {
        db.query_row(
            "SELECT id,seq FROM collaboration_tasks WHERE id=?1",
            [reference],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
    };
    row.context("task_not_found: Task does not exist")
}

fn normalize_task_input(db: &Connection, operation: &str, mut input: Value) -> Result<Value> {
    if matches!(
        operation,
        "task_get"
            | "task_update"
            | "task_claim"
            | "task_comment"
            | "task_submit_result"
            | "task_dispatch"
            | "peer_send" | "delivery_get" | "delivery_enable" | "delivery_continue" | "delivery_stop"
    ) {
        if let Some(reference) = input["taskId"].as_str() {
            input["taskId"] = json!(task_key(db, reference)?.0);
        }
    }
    // Missing priority is the historical normal mode. Equivalent retries from
    // old clients and new clients must share their existing receipt.
    if matches!(operation, "peer_send" | "task_dispatch") {
        input["priority"] = json!(message_priority(&input)?);
    }
    Ok(input)
}

fn message_priority(input: &Value) -> Result<&str> {
    match input.get("priority") {
        None => Ok("normal"),
        Some(Value::String(priority)) if matches!(priority.as_str(), "normal" | "urgent") => {
            Ok(priority)
        }
        _ => bail!("invalid_input: priority must be normal or urgent"),
    }
}

fn public_task(task: &mut Value) -> Result<()> {
    let seq = task["seq"]
        .as_i64()
        .filter(|seq| *seq > 0)
        .context("Task has no stable sequence")?;
    task["id"] = json!(task_number(seq));
    Ok(())
}

fn public_task_link(db: &Connection, value: &mut Value) -> Result<()> {
    if let Some(reference) = value["taskId"].as_str() {
        value["taskId"] = json!(task_number(task_key(db, reference)?.1));
    }
    Ok(())
}

fn public_message(db: &Connection, value: &mut Value) -> Result<()> {
    public_task_link(db, value)?;
    if value.get("priority").is_none() {
        value["priority"] = json!("normal");
    }
    Ok(())
}

/// Only known protocol slots are projected. User-authored descriptions, result
/// links, message bodies, actor IDs, message IDs and native IDs are untouched.
fn public_response(db: &Connection, mut output: Value) -> Result<Value> {
    if let Some(task) = output.get_mut("task") {
        public_task(task)?;
    }
    if let Some(tasks) = output.get_mut("tasks").and_then(Value::as_array_mut) {
        for task in tasks {
            public_task(task)?;
        }
    }
    if let Some(value) = output.get_mut("activity") {
        public_task_link(db, value)?;
        dispatch_materials::project_activity(value);
    }
    if let Some(value) = output.get_mut("message") {
        public_message(db, value)?;
    }
    if let Some(values) = output.get_mut("activities").and_then(Value::as_array_mut) {
        for value in values {
            public_task_link(db, value)?;
            dispatch_materials::project_activity(value);
        }
    }
    if let Some(values) = output.get_mut("messages").and_then(Value::as_array_mut) {
        for value in values {
            public_message(db, value)?;
        }
    }
    Ok(output)
}

/// Project membership lives outside the task record; every task in a response
/// carries its current link (`null` when it belongs to no project).
fn attach_task_projects(db: &Connection, output: &mut Value) -> Result<()> {
    let Some(fields) = output.as_object_mut() else {
        return Ok(());
    };
    // Material registrations are small opt-in task details, not list payloads.
    if let Some(task) = fields.get_mut("task") {
        if let Some(id) = task["id"].as_str() {
            let registration = dispatch_materials::registered(db, id)?;
            if !registration.is_null() { task["materials"] = registration["value"].clone(); }
        }
    }
    let compact = fields.contains_key("compact");
    let mut tasks: Vec<&mut Value> = Vec::new();
    for (key, value) in fields.iter_mut() {
        match (key.as_str(), value) {
            ("task", task) => tasks.push(task),
            ("tasks", Value::Array(list)) => tasks.extend(list.iter_mut()),
            _ => {}
        }
    }
    // One lookup for the whole page rather than a query per task. A compact
    // page counts its GitHub links instead of reading their snapshots.
    let (links, mut github, linked) = {
        let ids: Vec<&str> = tasks.iter().filter_map(|t| t["id"].as_str()).collect();
        let projects = crate::projects::task_projects(db, &ids)?;
        if compact {
            (projects, Default::default(), crate::github::store::task_link_counts(db, &ids)?)
        } else {
            (projects, crate::github::store::task_summaries(db, &ids)?, Default::default())
        }
    };
    for task in tasks {
        if let Some(id) = task["id"].as_str() {
            let project = json!(links.get(id));
            let (key, delivery) = if compact {
                ("githubLinks", json!(linked.get(id).copied().unwrap_or(0)))
            } else {
                ("github", json!(github.remove(id).unwrap_or_default()))
            };
            task["projectId"] = project;
            task[key] = delivery;
        }
    }
    Ok(())
}

/// Absent keeps the operation's default; null means no project.
fn project_input(db: &Connection, input: &Value) -> Result<Option<Option<String>>> {
    match input.get("projectId") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(id)) => {
            crate::projects::ensure_assignable(db, id)?;
            Ok(Some(Some(id.clone())))
        }
        _ => bail!("invalid_input: projectId must be a string or null"),
    }
}

fn allowed(input: &Value, fields: &[&str]) -> Result<()> {
    let map = input
        .as_object()
        .context("invalid_input: expected object")?;
    for key in map.keys() {
        ensure!(
            fields.contains(&key.as_str()),
            "invalid_input: unknown field {key}"
        );
    }
    Ok(())
}

fn required_text(input: &Value, field: &str, max: usize) -> Result<String> {
    let value = input[field]
        .as_str()
        .with_context(|| format!("invalid_input: {field} must be a string"))?;
    ensure!(
        !value.trim().is_empty(),
        "invalid_input: {field} must not be empty"
    );
    ensure!(
        value.len() <= max,
        "invalid_input: {field} is too long (maximum {max} bytes)"
    );
    Ok(value.into())
}

fn optional_text(input: &Value, field: &str, max: usize) -> Result<Option<String>> {
    match input.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => {
            ensure!(value.len() <= max, "invalid_input: {field} is too long");
            Ok(Some(value.clone()))
        }
        _ => bail!("invalid_input: {field} must be a string or null"),
    }
}

fn boolean(input: &Value, field: &str, default: bool) -> Result<bool> {
    match input.get(field) {
        None => Ok(default),
        Some(Value::Bool(value)) => Ok(*value),
        _ => bail!("invalid_input: {field} must be a boolean"),
    }
}

fn pagination(input: &Value) -> Result<(i64, i64)> {
    let after = match input.get("afterSeq") {
        None => 0,
        Some(v) => v
            .as_i64()
            .context("invalid_input: afterSeq must be an integer")?,
    };
    let limit = match input.get("limit") {
        None => 50,
        Some(v) => v
            .as_i64()
            .context("invalid_input: limit must be an integer")?,
    };
    ensure!(
        after >= 0 && (1..=200).contains(&limit),
        "invalid_input: afterSeq >= 0, limit 1..200 required"
    );
    Ok((after, limit))
}

/// Agents are read through their listed view (Store::brief_in), never by
/// parsing their records: those are megabytes, and these paths hold the
/// database for every collaboration call.
pub(crate) fn agent_actor(store: &Store, db: &Connection, id: &str) -> Result<TaskActor> {
    let agent = store.brief_in(db, id)?.context("agent_not_found: Agent does not exist")?.agent;
    Ok(TaskActor {
        kind: "agent".into(),
        id: agent.id,
        name: agent.name,
    })
}

pub(crate) fn actor_context(store: &Store, db: &Connection, id: Option<&str>) -> Result<(TaskActor, Value)> {
    let Some(id) = id else {
        return Ok((
            TaskActor {
                kind: "user".into(),
                id: "user".into(),
                name: "You".into(),
            },
            Value::Null,
        ));
    };
    let brief =
        store.brief_in(db, id)?.context("agent_not_found: calling Agent does not exist")?;
    let agent = &brief.agent;
    ensure!(
        agent.closed_at.is_none(),
        "agent_closed: calling Agent is closed"
    );
    let turn = brief.active_turn.as_deref();
    let session = match agent.harness.as_str() {
        "claude" => agent.claude_session_id.as_deref(),
        "opencode" => agent.opencode_session_id.as_deref(),
        _ => agent.thread_id.as_deref(),
    };
    let mut source = json!({"agentId":id});
    if let Some(turn) = turn {
        source["turnId"] = json!(turn);
    }
    if let Some(session) = session {
        source["sessionId"] = json!(session);
    }
    Ok((
        TaskActor {
            kind: "agent".into(),
            id: id.into(),
            name: agent.name.clone(),
        },
        source,
    ))
}

pub(crate) fn load_task(db: &Connection, id: &str) -> Result<SharedTask> {
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM collaboration_tasks WHERE id=?1",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    let mut task: SharedTask = serde_json::from_str(
        &raw.context("task_not_found: Task does not exist")?,
    )?;
    task.dispatch = result_dispatch::project(db, &task)?;
    Ok(task)
}

fn check_version(task: &SharedTask, input: &Value) -> Result<()> {
    let expected = input["expectedVersion"]
        .as_i64()
        .context("invalid_input: expectedVersion is required")?;
    ensure!(
        task.version == expected,
        "version_conflict: expected {expected}, current {}. Read the task before updating it",
        task.version
    );
    Ok(())
}

fn save_task(db: &Connection, task: &mut SharedTask, actor: &TaskActor) -> Result<()> {
    let previous = task.version;
    task.version += 1;
    task.updated_at = now();
    task.updated_by = actor.clone();
    let changed = db.execute(
        "UPDATE collaboration_tasks SET version=?1,data=?2 WHERE id=?3 AND version=?4",
        params![
            task.version,
            serde_json::to_string(task)?,
            task.id,
            previous
        ],
    )?;
    ensure!(changed == 1, "version_conflict: task was changed");
    crate::ci_monitor::lifecycle::reconcile(db, Some(&task.id))?;
    Ok(())
}

pub(crate) fn activity(
    db: &Connection,
    task_id: &str,
    kind: &str,
    actor: &TaskActor,
    source: &Value,
    extra: Value,
) -> Result<Value> {
    let mut value =
        json!({"seq":0,"taskId":task_id,"kind":kind,"actor":actor,"at":now(),"source":source});
    for (key, v) in extra.as_object().context("invalid activity")? {
        value[key] = v.clone();
    }
    db.execute(
        "INSERT INTO collaboration_task_activity(task_id,data) VALUES(?1,?2)",
        params![task_id, value.to_string()],
    )?;
    value["seq"] = json!(db.last_insert_rowid());
    db.execute(
        "UPDATE collaboration_task_activity SET data=?1 WHERE seq=?2",
        params![value.to_string(), value["seq"].as_i64()],
    )?;
    Ok(value)
}

fn peers_list(store: &Store, db: &Connection, input: &Value) -> Result<Value> {
    allowed(input, &["includeClosed"])?;
    let include_closed = boolean(input, "includeClosed", false)?;
    let memberships = crate::projects::agent_projects(db)?;
    let labels = crate::projects::project_labels(db)?;
    let mut q = db.prepare("SELECT id FROM agents ORDER BY rowid")?;
    let ids = q.query_map([], |r| r.get::<_, String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut peers = Vec::new();
    for id in ids {
        let Some(brief) = store.brief_in(db, &id)? else { continue };
        let a = brief.agent;
        if !include_closed && a.closed_at.is_some() {
            continue;
        }
        let project = memberships.get(&a.id).map(|id| {
            let (name, archived) = labels.get(id).cloned().unwrap_or_default();
            json!({"id":id,"name":name,"archived":archived})
        });
        peers.push(
            json!({"id":a.id,"name":a.name,"harness":a.harness,"status":a.status,
            "closedAt":a.closed_at,"cwd":a.cwd,"connectionState":a.connection_state,
            "machine":a.remote.map(|r| r.machine.name).unwrap_or_else(|| "Local".into()),
            "project":project}),
        );
    }
    Ok(json!({"peers":peers}))
}

fn task_create(store: &Store, db: &Connection, actor: &TaskActor, source: &Value, input: &Value) -> Result<Value> {
    allowed(
        input,
        &[
            "requestId",
            "title",
            "description",
            "status",
            "assigneeAgentId",
            "projectId",
            "materials",
        ],
    )?;
    let title = required_text(input, "title", 300)?;
    let materials = input.get("materials").map(|v| dispatch_materials::validate(db, v)).transpose()?;
    // Absent: the creating Agent's project at this moment (the user has none).
    // An archived project takes nothing new, so the default is then no project.
    let mut notice = None;
    let project = match project_input(db, input)? {
        Some(explicit) => explicit,
        None if actor.kind == "agent" => match crate::projects::agent_project(db, &actor.id)? {
            Some(id) if crate::projects::is_archived(db, &id)? => {
                notice = Some(json!({"code":"project_archived","projectId":id,
                    "message":"Your project is archived, so this task has no project."}));
                None
            }
            current => current,
        },
        None => None,
    };
    let status = optional_text(input, "status", 32)?.unwrap_or_else(|| "todo".into());
    ensure!(
        STATUSES.contains(&status.as_str()),
        "invalid_input: invalid task status"
    );
    let assignee_id = optional_text(input, "assigneeAgentId", 128)?;
    let assignee = assignee_id
        .as_deref()
        .map(|id| agent_actor(store, db, id))
        .transpose()?;
    let at = now();
    let mut task = SharedTask {
        id: uuid::Uuid::new_v4().to_string(),
        seq: 0,
        title,
        description: optional_text(input, "description", 32_768)?.unwrap_or_default(),
        status,
        assignee_agent_id: assignee_id,
        assignee,
        progress: String::new(),
        blocker: String::new(),
        result: None,
        dispatch: None,
        archived_at: None,
        version: 1,
        created_at: at.clone(),
        created_by: actor.clone(),
        updated_at: at,
        updated_by: actor.clone(),
    };
    db.execute(
        "INSERT INTO collaboration_tasks(id,version,data) VALUES(?1,1,?2)",
        params![task.id, serde_json::to_string(&task)?],
    )?;
    task.seq = db.last_insert_rowid();
    db.execute(
        "UPDATE collaboration_tasks SET data=?1 WHERE id=?2",
        params![serde_json::to_string(&task)?, task.id],
    )?;
    crate::projects::set_task_project(db, &task.id, project.as_deref())?;
    let mut changes = json!({"title":task.title,"status":task.status,"assigneeAgentId":task.assignee_agent_id,"projectId":project});
    if let Some(materials) = materials { changes["materials"] = materials; }
    let event = activity(
        db,
        &task.id,
        "created",
        actor,
        source,
        json!({"changes":changes,"taskVersion":task.version}),
    )?;
    let mut output = json!({"task":task,"activity":event});
    if let Some(notice) = notice {
        output["projectNotice"] = notice;
    }
    Ok(output)
}

fn task_update(store: &Store, db: &Connection, actor: &TaskActor, source: &Value, input: &Value) -> Result<Value> {
    allowed(input, &["requestId", "taskId", "expectedVersion", "patch"])?;
    let mut task = load_task(db, &required_text(input, "taskId", 128)?)?;
    check_version(&task, input)?;
    let previous_assignee = task.assignee_agent_id.clone();
    let patch = &input["patch"];
    allowed(
        patch,
        &[
            "title",
            "description",
            "status",
            "assigneeAgentId",
            "progress",
            "blocker",
            "archived",
            "projectId",
            "materials",
        ],
    )?;
    ensure!(
        !patch.as_object().unwrap().is_empty(),
        "invalid_input: patch must not be empty"
    );
    let mut changes = patch.clone();
    if let Some(materials) = patch.get("materials") {
        changes["materials"] = dispatch_materials::validate(db, materials)?;
    }
    // Shares this task's version check, version bump and activity record.
    if let Some(project) = project_input(db, patch)? {
        crate::projects::set_task_project(db, &task.id, project.as_deref())?;
    }
    if patch.get("title").is_some() {
        task.title = required_text(patch, "title", 300)?;
    }
    if patch.get("description").is_some() {
        task.description = optional_text(patch, "description", 32_768)?.unwrap_or_default();
    }
    if patch.get("progress").is_some() {
        task.progress = optional_text(patch, "progress", 8_192)?.unwrap_or_default();
    }
    if patch.get("blocker").is_some() {
        task.blocker = optional_text(patch, "blocker", 8_192)?.unwrap_or_default();
    }
    if patch.get("status").is_some() {
        let status = required_text(patch, "status", 32)?;
        ensure!(
            STATUSES.contains(&status.as_str()),
            "invalid_input: invalid task status"
        );
        task.status = status;
    }
    if patch.get("assigneeAgentId").is_some() {
        task.assignee_agent_id = optional_text(patch, "assigneeAgentId", 128)?;
        task.assignee = task
            .assignee_agent_id
            .as_deref()
            .map(|id| agent_actor(store, db, id))
            .transpose()?;
    }
    if patch.get("archived").is_some() {
        task.archived_at = if boolean(patch, "archived", false)? {
            Some(now())
        } else {
            None
        };
    }
    result_dispatch::invalidate(&mut task, previous_assignee.as_deref());
    save_task(db, &mut task, actor)?;
    let event = activity(
        db,
        &task.id,
        "updated",
        actor,
        source,
        json!({"changes":changes,"taskVersion":task.version,"dispatchInvalidatedAt":task.dispatch.as_ref().and_then(|d| d.invalidated_at.as_deref())}),
    )?;
    Ok(json!({"task":task,"activity":event}))
}

fn task_claim(db: &Connection, actor: &TaskActor, source: &Value, input: &Value) -> Result<Value> {
    allowed(input, &["requestId", "taskId", "expectedVersion", "start"])?;
    ensure!(
        actor.kind == "agent",
        "invalid_input: claim requires an Agent; use assignment for GUI actions"
    );
    let mut task = load_task(db, &required_text(input, "taskId", 128)?)?;
    check_version(&task, input)?;
    ensure!(
        task.assignee_agent_id.is_none(),
        "already_claimed: task already has a principal assignee"
    );
    ensure!(
        task.archived_at.is_none() && !matches!(task.status.as_str(), "done" | "cancelled"),
        "task_closed: reopen the task before claiming it"
    );
    task.assignee_agent_id = Some(actor.id.clone());
    task.assignee = Some(actor.clone());
    if boolean(input, "start", false)? {
        task.status = "doing".into();
    }
    save_task(db, &mut task, actor)?;
    let event = activity(
        db,
        &task.id,
        "claimed",
        actor,
        source,
        json!({"changes":{"assigneeAgentId":actor.id,"status":task.status}}),
    )?;
    Ok(json!({"task":task,"activity":event}))
}

fn task_comment(
    db: &Connection,
    actor: &TaskActor,
    source: &Value,
    input: &Value,
) -> Result<Value> {
    allowed(input, &["requestId", "taskId", "body"])?;
    let task = load_task(db, &required_text(input, "taskId", 128)?)?;
    let body = required_text(input, "body", 16_384)?;
    // Comments are append-only; they never invalidate another editor's version.
    let event = activity(db, &task.id, "comment", actor, source, json!({"body":body}))?;
    Ok(json!({"task":task,"activity":event}))
}

fn task_submit_result(
    store: &Store,
    db: &Connection,
    actor: &TaskActor,
    source: &Value,
    input: &Value,
) -> Result<Value> {
    allowed(
        input,
        &[
            "requestId",
            "taskId",
            "expectedVersion",
            "summary",
            "links",
            "status",
            "dispatchId",
            "delivery",
        ],
    )?;
    let mut task = load_task(db, &required_text(input, "taskId", 128)?)?;
    check_version(&task, input)?;
    let dispatch = result_dispatch::validate(db, &task, actor, input)?;
    let summary = required_text(input, "summary", 16_384)?;
    let links = input.get("links").cloned().unwrap_or_else(|| json!([]));
    let entries = links
        .as_array()
        .context("invalid_input: links must be an array")?;
    ensure!(
        entries.len() <= 30,
        "invalid_input: at most 30 result links"
    );
    for entry in entries {
        allowed(entry, &["label", "url"])?;
        required_text(entry, "label", 300)?;
        let url = required_text(entry, "url", 4_096)?;
        ensure!(
            url.starts_with("https://") || url.starts_with("http://"),
            "invalid_input: result links must use http or https"
        );
    }
    let status = optional_text(input, "status", 32)?.unwrap_or_else(|| "review".into());
    ensure!(
        matches!(status.as_str(), "review" | "done"),
        "invalid_input: result status must be review or done"
    );
    let notification = result_dispatch::notification(store, db, dispatch.as_ref())?;
    task.result = Some(json!({"id":uuid::Uuid::new_v4().to_string(),
        "dispatchId":dispatch.as_ref().map(|d| &d.id),"notification":notification,
        "summary":summary,"links":links,"reportedAt":now(),"reportedBy":actor,"source":source}));
    task.status = status;
    crate::delivery::store::submitted(db, &task, actor, input)?;
    save_task(db, &mut task, actor)?;
    let event = activity(
        db,
        &task.id,
        "result",
        actor,
        source,
        json!({"result":task.result,"changes":{"status":task.status}}),
    )?;
    let message = result_dispatch::notify(store, db, &task, &event)?;
    let mut output = json!({"task":task,"activity":event});
    if let Some(message) = message { output["message"] = message; }
    // Advice for a Home content editor of the task's Project; nothing more,
    // so a failed lookup leaves it out instead of failing the result.
    if actor.kind == "agent" {
        match crate::project_brief::home_hint(store, db, &task.id, &actor.id) {
            Ok(Some(advice)) => advice.apply(&mut output),
            Ok(None) => {}
            Err(error) => eprintln!("Home hint for {}'s result: {error:#}", task.id),
        }
    }
    Ok(output)
}

fn task_dispatch(
    store: &Store,
    db: &Connection,
    actor: &TaskActor,
    source: &Value,
    input: &Value,
) -> Result<Value> {
    allowed(
        input,
        &[
            "requestId",
            "taskId",
            "expectedVersion",
            "toAgentId",
            "body",
            "priority",
            "materials",
        ],
    )?;
    let mut task = load_task(db, &required_text(input, "taskId", 128)?)?;
    check_version(&task, input)?;
    ensure!(
        task.archived_at.is_none(),
        "task_archived: unarchive the task first"
    );
    let recipient_id = required_text(input, "toAgentId", 128)?;
    let recipient = store.brief_in(db, &recipient_id)?
        .context("agent_not_found: recipient does not exist")?;
    ensure!(
        recipient.agent.closed_at.is_none(),
        "agent_closed: reopen the recipient before dispatching work"
    );
    task.assignee_agent_id = Some(recipient_id.clone());
    task.assignee = Some(agent_actor(store, db, &recipient_id)?);
    task.dispatch = Some(TaskDispatch::new(actor, source, task.assignee.as_ref().unwrap()));
    task.status = "doing".into();
    save_task(db, &mut task, actor)?;
    let materials = dispatch_materials::snapshot(db, &task, input)?;
    let body = dispatch_materials::body(&materials);
    let message = create_message(
        store,
        db,
        actor,
        source,
        &json!({"toAgentId":recipient_id,"body":body,"taskId":task.id,"priority":message_priority(input)?,"dispatchId":task.dispatch.as_ref().unwrap().id,
            "materialsRef":{"schemaVersion":1,"taskId":task_number(task.seq),"dispatchId":task.dispatch.as_ref().unwrap().id,"taskVersion":task.version,"capturedAt":materials["capturedAt"]}}),
    )?;
    let event = activity(
        db,
        &task.id,
        "dispatched",
        actor,
        source,
        json!({"changes":{"assigneeAgentId":recipient_id,"status":"doing"},"messageId":message["id"],"dispatch":task.dispatch,"materials":materials}),
    )?;
    Ok(json!({"task":task,"message":message,"activity":event}))
}

fn task_list(db: &Connection, input: &Value) -> Result<Value> {
    allowed(
        input,
        &[
            "afterSeq",
            "limit",
            "status",
            "statuses",
            "assigneeAgentId",
            "archived",
            "query",
            "projectId",
            "compact",
        ],
    )?;
    let (after, limit) = pagination(input)?;
    let compact = boolean(input, "compact", false)?;
    // Absent lists every project; null lists tasks that belong to none.
    let (project_filter, project) = match input.get("projectId") {
        None => (0, None),
        Some(Value::Null) => (1, None),
        Some(Value::String(id)) => {
            // A wrong ID is an error, not an empty project.
            crate::projects::ensure_exists(db, id)?;
            (2, Some(id.clone()))
        }
        _ => bail!("invalid_input: projectId must be a string or null"),
    };
    let status = optional_text(input, "status", 32)?;
    if let Some(status) = &status {
        ensure!(
            STATUSES.contains(&status.as_str()),
            "invalid_input: invalid task status"
        );
    }
    // Any of several statuses (for example open work), filtered before paging
    // like every other condition. `status` keeps its meaning for old clients.
    let statuses = match input.get("statuses") {
        None => None,
        Some(Value::Array(items)) => {
            ensure!(status.is_none(), "invalid_input: use status or statuses, not both");
            ensure!(!items.is_empty(), "invalid_input: statuses must not be empty");
            let mut list: Vec<String> = Vec::new();
            for item in items {
                let value = item.as_str().context("invalid_input: statuses must be strings")?;
                ensure!(STATUSES.contains(&value), "invalid_input: invalid task status");
                ensure!(!list.iter().any(|s| s == value), "invalid_input: duplicate status in statuses");
                list.push(value.into());
            }
            Some(list)
        }
        _ => bail!("invalid_input: statuses must be an array of task statuses"),
    };
    let status_filter = statuses
        .or_else(|| status.map(|s| vec![s]))
        .map(|list| serde_json::to_string(&list))
        .transpose()?;
    let assignee = optional_text(input, "assigneeAgentId", 128)?;
    let archived = boolean(input, "archived", false)?;
    let query = optional_text(input, "query", 300)?.unwrap_or_default();
    let mut q = db.prepare("SELECT data FROM collaboration_tasks
        WHERE (?1 IS NULL OR json_extract(data,'$.status') IN (SELECT value FROM json_each(?1)))
          AND (?2 IS NULL OR json_extract(data,'$.assigneeAgentId')=?2)
          AND (json_extract(data,'$.archivedAt') IS NOT NULL)=?3
          AND (?4='' OR instr(lower(json_extract(data,'$.title') || ' ' || json_extract(data,'$.description')),lower(?4))>0)
          AND (?5=0
            OR (?5=1 AND NOT EXISTS(SELECT 1 FROM project_tasks p WHERE p.task_id=collaboration_tasks.id))
            OR (?5=2 AND EXISTS(SELECT 1 FROM project_tasks p WHERE p.task_id=collaboration_tasks.id AND p.project_id=?6)))
        ORDER BY seq")?;
    let rows = q.query_map(params![status_filter, assignee, archived, query, project_filter, project], |r| {
        r.get::<_, String>(0)
    })?;
    let mut counts = json!({"todo":0,"doing":0,"blocked":0,"review":0,"done":0,"cancelled":0});
    if compact {
        // The same conditions, counts and paging; each row is read as the
        // short row it becomes (compact.rs), and dispatch is not projected.
        let mut page = Vec::new();
        for row in rows {
            let row: compact::Row = serde_json::from_str(&row?)?;
            counts[&row.status] = json!(counts[&row.status].as_i64().unwrap_or(0) + 1);
            if row.seq > after && page.len() <= limit as usize {
                page.push(row);
            }
        }
        let has_more = page.len() > limit as usize;
        page.truncate(limit as usize);
        let next = page.last().map(|t| t.seq).unwrap_or(after);
        let tasks: Vec<Value> = page.iter().map(compact::Row::value).collect();
        return Ok(json!({"tasks":tasks,"counts":counts,"nextAfterSeq":next,"hasMore":has_more,"compact":compact::NOTE}));
    }
    let mut tasks = Vec::new();
    for row in rows {
        let task: SharedTask = serde_json::from_str(&row?)?;
        counts[&task.status] = json!(counts[&task.status].as_i64().unwrap_or(0) + 1);
        if task.seq > after && tasks.len() <= limit as usize {
            tasks.push(task);
        }
    }
    let has_more = tasks.len() > limit as usize;
    tasks.truncate(limit as usize);
    for task in &mut tasks {
        task.dispatch = result_dispatch::project(db, task)?;
    }
    let next = tasks.last().map(|t| t.seq).unwrap_or(after);
    Ok(json!({"tasks":tasks,"counts":counts,"nextAfterSeq":next,"hasMore":has_more}))
}

fn task_get(db: &Connection, input: &Value) -> Result<Value> {
    allowed(input, &["taskId", "afterSeq", "limit", "dispatchId", "view"])?;
    let id = required_text(input, "taskId", 128)?;
    // "full" (the default here, and the GUI's) is the whole record; "current"
    // and "activity" read none of the history they do not show (current.rs).
    let view = optional_text(input, "view", 16)?.unwrap_or_else(|| "full".into());
    ensure!(matches!(view.as_str(), "full" | "current" | "activity"),
        "invalid_input: view is current, activity or full");
    if let Some(dispatch) = optional_text(input, "dispatchId", 128)? {
        ensure!(input.get("view").is_none(), "invalid_input: dispatchId reads the fixed materials; omit view");
        // Fixed reads never assemble current dispatch state, activity, execution
        // history or repository lists. Read the latest task separately if needed.
        let (id, seq) = task_key(db, &id)?;
        return Ok(json!({"dispatchMaterials":dispatch_materials::read(db, &id, &dispatch)?,
            "latestTask":{"taskId":task_number(seq)}}));
    }
    let task = load_task(db, &id)?;
    if view == "current" {
        ensure!(input.get("afterSeq").is_none() && input.get("limit").is_none(),
            "invalid_input: afterSeq and limit page the history: use view \"activity\"");
        return current::current(db, &task);
    }
    let (after, limit) = pagination(input)?;
    if view == "activity" {
        return current::activity(db, &task, after, limit);
    }
    let registration = dispatch_materials::registered(db, &task.id)?;
    let mut q =
        db.prepare("SELECT data FROM collaboration_task_activity WHERE task_id=?1 ORDER BY seq")?;
    let rows = q.query_map([&task.id], |r| r.get::<_, String>(0))?;
    let mut activities = Vec::new();
    let mut executions = Vec::new();
    for row in rows {
        let value: Value = serde_json::from_str(&row?)?;
        add_execution(&mut executions, &value["source"]);
        if value["seq"].as_i64().unwrap_or(0) > after && activities.len() <= limit as usize {
            activities.push(value);
        }
    }
    let mut q = db.prepare("SELECT data,delivery_detail FROM collaboration_messages WHERE json_extract(data,'$.taskId')=?1 ORDER BY seq")?;
    for row in q.query_map([&task.id], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })? {
        let (message, detail) = row?;
        let message: Value = serde_json::from_str(&message)?;
        add_execution(&mut executions, &message["source"]);
        let detail: Value = serde_json::from_str(&detail)?;
        add_execution(&mut executions, &detail);
    }
    let has_more = activities.len() > limit as usize;
    activities.truncate(limit as usize);
    let next = activities
        .last()
        .and_then(|v| v["seq"].as_i64())
        .unwrap_or(after);
    let mut output = json!({"task":task,"activities":activities,"executions":executions,"nextAfterSeq":next,"hasMore":has_more});
    output["materialsSource"] = registration;
    Ok(output)
}

fn add_execution(executions: &mut Vec<Value>, source: &Value) {
    // A session alone is not an execution of this particular task.
    if source["agentId"].as_str().is_none() || source["turnId"].as_str().is_none() {
        return;
    }
    let mut reference = json!({"agentId":source["agentId"],"turnId":source["turnId"]});
    if let Some(session) = source["sessionId"].as_str() {
        reference["sessionId"] = json!(session);
    }
    if let Some(existing) = executions
        .iter_mut()
        .find(|e| e["agentId"] == reference["agentId"] && e["turnId"] == reference["turnId"])
    {
        if reference.get("sessionId").is_some() {
            existing["sessionId"] = reference["sessionId"].clone();
        }
    } else {
        executions.push(reference);
    }
}

fn load_message(db: &Connection, id: &str) -> Result<Value> {
    let row: Option<(String, String, String, Option<String>)> = db.query_row(
        "SELECT m.data,m.delivery_state,m.delivery_detail,r.read_at FROM collaboration_messages m
         LEFT JOIN collaboration_message_reads r ON r.message_seq=m.seq AND r.reader_id=m.recipient_id WHERE m.id=?1",
        [id], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let (raw, state, detail, read_at) = row.context("message_not_found: Message does not exist")?;
    let mut message: Value = serde_json::from_str(&raw)?;
    message["delivery"] = json!({"state":state,"detail":serde_json::from_str::<Value>(&detail)?});
    message["firstReadAt"] = json!(read_at);
    Ok(message)
}

fn create_message(
    store: &Store,
    db: &Connection,
    actor: &TaskActor,
    source: &Value,
    input: &Value,
) -> Result<Value> {
    let to = required_text(input, "toAgentId", 128)?;
    ensure!(
        actor.kind != "agent" || actor.id != to,
        "invalid_input: choose another Agent as recipient"
    );
    let recipient = agent_actor(store, db, &to)?;
    let body = required_text(input, "body", 16_384)?;
    let priority = message_priority(input)?;
    let mut task_id = optional_text(input, "taskId", 128)?;
    let reply_to = optional_text(input, "replyTo", 128)?;
    let id = uuid::Uuid::new_v4().to_string();
    let mut thread_id = id.clone();
    if let Some(parent_id) = &reply_to {
        let parent = load_message(db, parent_id)?;
        let from_id = parent["sender"]["id"]
            .as_str()
            .context("invalid message sender")?;
        let to_id = parent["recipient"]["id"]
            .as_str()
            .context("invalid message recipient")?;
        if actor.kind == "agent" {
            ensure!(
                (actor.id == from_id && to == to_id) || (actor.id == to_id && to == from_id),
                "invalid_reply: reply must retain the original participants"
            );
        } else {
            ensure!(
                to == from_id || to == to_id,
                "invalid_reply: recipient is not in the original thread"
            );
        }
        let parent_task = parent["taskId"].as_str();
        if task_id.is_some() && parent_task.is_some() {
            ensure!(
                task_id.as_deref() == parent_task,
                "invalid_reply: taskId differs from parent message"
            );
        }
        if task_id.is_none() {
            task_id = parent_task.map(str::to_owned);
        }
        thread_id = parent["threadId"].as_str().unwrap_or(parent_id).into();
    }
    if let Some(task_id) = &task_id {
        load_task(db, task_id)?;
    }
    let mut message = json!({"id":id,"seq":0,"sender":actor,"recipient":recipient,"body":body,
        "taskId":task_id,"replyTo":reply_to,"threadId":thread_id,"createdAt":now(),"source":source,"priority":priority});
    // Internal dispatch context only; peer_send's public allowlist rejects it.
    if let Some(dispatch) = input.get("dispatchId") {
        message["dispatchId"] = dispatch.clone();
        if let Some(reference) = input.get("materialsRef") { message["materialsRef"] = reference.clone(); }
        message["resultInstructions"] = json!("Pass this message's dispatchId to task_submit_result. Do not substitute a newer dispatchId after reassignment. Result notification is automatic; no extra peer_send is needed.");
    }
    insert_message(db, message)
}

/// Persist a validated message inside the caller's transaction. System-owned
/// operations use this same mailbox; their author is never a user or Agent.
pub(crate) fn insert_message(db: &Connection, mut message: Value) -> Result<Value> {
    message["notice"] = crate::mailbox_notice::message_notice(&message);
    let id = message["id"].as_str().context("Missing message identity")?.to_owned();
    let sender_id = message["sender"]["id"].as_str().context("Missing message sender")?;
    let to = message["recipient"]["id"].as_str().context("Missing message recipient")?;
    db.execute(
        "INSERT INTO collaboration_messages(id,sender_id,recipient_id,data) VALUES(?1,?2,?3,?4)",
        params![id, sender_id, to, message.to_string()],
    )?;
    message["seq"] = json!(db.last_insert_rowid());
    db.execute(
        "UPDATE collaboration_messages SET data=?1 WHERE id=?2",
        params![message.to_string(), id],
    )?;
    message["delivery"] = json!({"state":"pending","detail":{}});
    message["firstReadAt"] = Value::Null;
    Ok(message)
}

fn peer_read(db: &Connection, actor: Option<&str>, input: &Value) -> Result<Value> {
    allowed(input, &["agentId", "afterSeq", "limit", "priority"])?;
    let requested = optional_text(input, "agentId", 128)?;
    if let (Some(actor), Some(requested)) = (actor, requested.as_deref()) {
        ensure!(
            actor == requested,
            "forbidden: an Agent can fetch only its own inbox"
        );
    }
    let recipient = actor.or(requested.as_deref());
    let (after, limit) = pagination(input)?;
    let priority = input
        .get("priority")
        .map(|_| message_priority(input))
        .transpose()?;
    let mut q = db.prepare("SELECT id,seq FROM collaboration_messages WHERE seq>?1 AND (?2 IS NULL OR recipient_id=?2)
        AND (?4 IS NULL OR COALESCE(json_extract(data,'$.priority'),'normal')=?4) ORDER BY seq LIMIT ?3")?;
    let rows: Vec<(String, i64)> = q
        .query_map(params![after, recipient, limit + 1, priority], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let has_more = rows.len() > limit as usize;
    let mut messages = Vec::new();
    let mut next = after;
    for (id, seq) in rows.into_iter().take(limit as usize) {
        if let Some(actor) = actor {
            db.execute("INSERT OR IGNORE INTO collaboration_message_reads(message_seq,reader_id,read_at) VALUES(?1,?2,?3)", params![seq,actor,now()])?;
        }
        messages.push(load_message(db, &id)?);
        next = seq;
    }
    Ok(json!({"messages":messages,"nextAfterSeq":next,"hasMore":has_more}))
}

/// Keep the protocol narrow: native plans and turn completion are not task APIs.
/// How every tool describes a taskId parameter.
pub(crate) const TASK_ID: &str = "Existing task ID, for example T-1. Reuse the same task across steps and retries.";

pub fn tool_definitions() -> Vec<Value> {
    let string = json!({"type":"string"});
    let nullable_string = json!({"type":["string","null"]});
    let task_reference = json!({"type":"string","description":TASK_ID});
    let nullable_task_reference = json!({"type":["string","null"],"description":TASK_ID});
    let request = json!({"type":"string","minLength":1,"maxLength":128,"description":"Stable retry key. Reuse only when retrying exactly this operation and payload."});
    let version = json!({"type":"integer","minimum":1,"description":"Current task version returned by task_get/list; conflicts require rereading."});
    let after = json!({"type":"integer","minimum":0,"default":0});
    let limit = json!({"type":"integer","minimum":1,"maximum":200,"default":50});
    let status = json!({"type":"string","enum":STATUSES});
    let priority = json!({"type":"string","enum":["normal","urgent"],"default":"normal","description":"normal waits until the recipient's current turn ends. urgent requests a native reminder as soon as possible, including during a running turn; it does not interrupt or replace the task."});
    let create_project = json!({"type":["string","null"],"description":"Project ID from projects_list. Omit to file the task under your own current project (none if you have no project or it is archived); null creates it without a project."});
    let list_project = json!({"type":["string","null"],"description":"Project ID from projects_list. Omit to list every project; null lists only tasks without a project. An unknown ID is an error."});
    let read_priority = json!({"type":"string","enum":["normal","urgent"],"description":"Read only this priority. Use the priority and afterSeq from a mailbox notification, and keep that priority while paging. Omit only to intentionally read all mail."});
    let definition = |name: &str, description: &str, properties: Value, required: &[&str]| {
        json!({
        "name":name,"description":description,
        "inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})
    };
    vec![
        definition("peers_list", "List existing Workspace Agents, their project and native runtime state. Runtime state is not shared task status. Agents in different projects can still message and help each other.", json!({"includeClosed":{"type":"boolean","default":false}}), &[]),
        definition("projects_list", "List this Workspace's projects with their IDs, including projects without agents. Archived projects are marked and accept no new tasks. Task IDs are shared across projects.", json!({}), &[]),
        definition("peer_send", "Send durable correspondence to another existing Agent. The sender is authenticated by Core. Normal mail waits for the current turn to finish; choose urgent only when the recipient needs a reminder during current work. Delivery does not prove it was read or acted on. Use taskId for an existing shared goal and replyTo for a reply.", json!({"requestId":request,"toAgentId":string,"body":string,"taskId":nullable_task_reference,"replyTo":nullable_string,"priority":priority}), &["requestId","toAgentId","body"]),
        definition("peer_read", "Fetch your durable inbox after an explicit sequence. Retrying the same cursor returns the same messages; Core never silently advances your cursor. Keep a notification's priority filter while paging so urgent reads do not consume normal mail. firstReadAt means fetched, not understood or completed.", json!({"afterSeq":after,"limit":limit,"priority":read_priority}), &[]),
        definition("task_list", "List shared goals, not native plans or execution logs. Continue existing work by taskId. Without filters it lists every project's and every assignee's tasks that are not archived (archived:true lists only archived ones), in creation order, 50 per page (limit up to 200); pass nextAfterSeq as afterSeq while hasMore. Every filter is applied before paging and to counts. Omit projectId for every project; null lists tasks without a project. compact:true gives short rows; task_get reads one task whole.", json!({"compact":{"type":"boolean","default":false,"description":"Short rows: id, title, status, version, assignee, updatedAt, projectId, githubLinks (a count) and the first 200 characters of progress and blocker. Description, result, dispatch and GitHub snapshots are left out; filters, counts and paging are unchanged."},"afterSeq":after,"limit":limit,"status":status,"statuses":{"type":"array","items":status,"minItems":1,"uniqueItems":true,"description":"Match any of these statuses, for example open work = todo, doing, blocked, review. Use instead of status, not with it."},"assigneeAgentId":nullable_string,"archived":{"type":"boolean","default":false},"query":string,"projectId":list_project}), &[]),
        definition("task_get", "Read a shared task. Use the same taskId across implementation, review, retry, and recovery. Views (view): \"current\" (your default without afterSeq, limit or dispatchId) is what to decide with now: status, version, assignee, dispatch, a short result, the newest activity and the current delivery (each linked PR's head and base with that head's CI as last observed, its newest review, the newest CI subscriptions and their runs), without reading the history; \"activity\" (your default with afterSeq or limit) is one page of the history, oldest first; \"full\" is the whole record: description, materials, every activity page and execution references. Long text in current is cut and says so. Task writes answer you with a short receipt (taskId, version, status, the activity's seq); read the task for more.", json!({"taskId":task_reference,"afterSeq":after,"limit":limit,"view":{"type":"string","enum":["current","activity","full"]},"dispatchId":{"type":"string","description":"Read only immutable dispatchMaterials and a latestTask reference, without activity or execution history. Omit dispatchId to read the latest task. Normal activity pages return only material references."}}), &["taskId"]),
        definition("task_create", "Create an independent deliverable only when no existing task represents it. Title example: 'Preview files at a requested line with an out-of-range hint'. Do not turn native plan steps, shell calls, turn completions, or routine retries into cards. Description is stable scope/completion context; later progress belongs in progress or comments. Only title is a required content field. Task IDs are shared across projects; projectId rules are in its schema.", json!({"requestId":request,"title":string,"description":string,"status":status,"assigneeAgentId":nullable_string,"projectId":create_project,"materials":dispatch_materials::schema()}), &["requestId","title"]),
        definition("task_update", "Explicitly edit task fields with optimistic version checking. Task state is a statement about the goal; runtime completion does not automatically mean done. Assignment does not notify or start an Agent. Cancelling does not stop its process. A principal assignee does not exclude collaborators. To let the user decide a status change instead, publish it as a TaskStatus proposal with result_publish; it changes nothing until the user confirms it.", json!({"requestId":request,"taskId":task_reference,"expectedVersion":version,"patch":{"type":"object","minProperties":1,"additionalProperties":false,"properties":{"title":string,"description":nullable_string,"status":status,"assigneeAgentId":nullable_string,"progress":nullable_string,"blocker":nullable_string,"archived":{"type":"boolean"},"projectId":{"type":["string","null"],"description":"Move the task to this project; null removes it from its project."},"materials":dispatch_materials::schema()}}}), &["requestId","taskId","expectedVersion","patch"]),
        definition("task_claim", "Atomically become the principal assignee of an unassigned task. A competing claim fails; collaborators may still read, comment, and submit review results. start optionally changes task state to doing; it does not spawn a process or acquire a lease.", json!({"requestId":request,"taskId":task_reference,"expectedVersion":version,"start":{"type":"boolean","default":false}}), &["requestId","taskId","expectedVersion"]),
        definition("task_comment", "Append useful discussion or a progress note to an existing task. Does not change its definition, current result, semantic version, or board order.", json!({"requestId":request,"taskId":task_reference,"body":string}), &["requestId","taskId","body"]),
        definition("task_submit_result", "Publish a concise outcome on the existing task with optional http/https deliverable links. Defaults to review; choose done only when explicitly reporting completion. The author and execution source are recorded by Core, not independently verified by another model. For dispatched work pass dispatchId from your original assignment message: Core automatically notifies the fixed dispatching Agent, so no extra peer_send is needed. Never substitute a newer dispatchId after reassignment. Old clients omitting it are rejected for tracked executors. GUI/unbound collaborators and legacy untracked work remain supported without automatic notification.", json!({"requestId":request,"taskId":task_reference,"expectedVersion":version,"dispatchId":{"type":"string","description":"Identity from your original task_dispatch message, independent of expectedVersion. Required for tracked executors; stale or invalidated assignments are rejected without changing the task."},"delivery":crate::delivery::submission_schema(),"summary":string,"links":{"type":"array","maxItems":30,"items":{"type":"object","properties":{"label":string,"url":string},"required":["label","url"],"additionalProperties":false}},"status":{"type":"string","enum":["review","done"],"default":"review"}}), &["requestId","taskId","expectedVersion","summary"]),
        // Project Briefs; served by `project_brief`, not here.
        crate::project_brief::tool_definition("brief_get"),
        crate::project_brief::tool_definition("brief_update"),
        crate::project_brief::tool_definition("brief_guide"),
        definition("task_dispatch", "Assign an existing task to an Agent, or reassign it: atomically set doing, record a new stable dispatchId and fixed result recipient, and send an associated durable message. The executor must retain message.dispatchId for task_submit_result; each dispatch supersedes the previous one even for the same Agent, so further instructions within the same assignment go by peer_send with taskId instead. Results automatically notify the dispatching Agent; GUI dispatch has no Agent recipient. Does not create another task, spawn an Agent, or restart a closed Agent. Normal delivery waits for the current turn; urgent requests an earlier native reminder. Automatic materials include the saved goal, explicit acceptance, repositories and GitHub snapshots, registered worktree/references and return requirements. Read full fixed material fields with task_get using the original dispatchId; body is only a supplement. Missing facts stay unspecified. A queued message is not proof that execution has begun.", json!({"requestId":request,"taskId":task_reference,"expectedVersion":version,"toAgentId":string,"body":{"type":"string","description":"Optional supplemental instructions; never replaces automatic task/materials context. Empty is allowed."},"priority":priority,"materials":dispatch_materials::schema()}), &["requestId","taskId","expectedVersion","toAgentId"]),
        // Generated from the result contract; served by `results`, not here.
        crate::results::tool_definition(),
        crate::results::guide_tool_definition(),
        // The working guide, compiled from the yuzuno skill; served by `guide`.
        crate::guide::tool_definition(),
    ].into_iter().chain(crate::github::tool_definitions()).chain(crate::pr_review::tool_definitions()).chain(crate::pr_operations::tool_definitions()).chain(crate::jobs::tool_definitions()).chain(crate::ci_monitor::tool_definitions()).chain(crate::delivery::tool_definitions()).chain(crate::services::tool_definitions()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::AgentDetail;
    use std::sync::{Arc, Barrier};

    fn agent(id: &str) -> AgentDetail {
        serde_json::from_value(json!({"agent":{"id":id,"name":format!("Agent {id}"),
            "cwd":"/workspace","model":"test","color":"sage","threadId":format!("session-{id}"),
            "status":"idle","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]}))
        .unwrap()
    }

    fn fixture() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("workspace.db")).unwrap();
        for id in ["a", "b", "c"] {
            store.insert(&agent(id)).unwrap();
        }
        (dir, store)
    }

    fn create(store: &Store) -> Value {
        store.collaboration_call(None, "task_create", json!({"requestId":"create","title":"Preview files at the requested line","description":"Preserve the existing conversation and explain out-of-range lines."})).unwrap()["task"].clone()
    }

    fn get(store: &Store, id: &Value) -> Value {
        store
            .collaboration_call(None, "task_get", json!({"taskId":id}))
            .unwrap()
    }

    fn internal_id(store: &Store, seq: i64) -> String {
        store
            .db
            .read()
            .unwrap()
            .query_row(
                "SELECT id FROM collaboration_tasks WHERE seq=?1",
                [seq],
                |r| r.get(0),
            )
            .unwrap()
    }

    #[test]
    fn short_task_numbers_are_the_public_ids_for_tasks_activity_and_mail() {
        let (_dir, store) = fixture();
        let task = create(&store);
        assert_eq!(task["id"], "T-1");
        assert_eq!(task["seq"], 1);
        let uuid = internal_id(&store, 1);
        assert!(uuid::Uuid::parse_str(&uuid).is_ok());
        assert_eq!(get(&store, &json!(uuid)), get(&store, &json!("T-1")));
        let comment = store
            .collaboration_call(
                Some("a"),
                "task_comment",
                json!({"requestId":"short-comment","taskId":"T-1","body":"Review this same work."}),
            )
            .unwrap();
        assert_eq!(comment["task"]["id"], "T-1");
        assert_eq!(comment["activity"]["taskId"], "T-1");
        assert_eq!(comment["activity"]["actor"]["id"], "a");
        let body = format!("Historical reference {uuid} must remain verbatim.");
        let message = store
            .collaboration_call(
                Some("a"),
                "peer_send",
                json!({"requestId":"short-mail","toAgentId":"b","taskId":"T-1","body":body}),
            )
            .unwrap()["message"]
            .clone();
        assert_eq!(message["taskId"], "T-1");
        assert_eq!(message["body"], body);
        assert!(
            uuid::Uuid::parse_str(message["id"].as_str().unwrap()).is_ok(),
            "message IDs are outside the task numbering scheme"
        );
        let retried = store
            .collaboration_call(
                Some("a"),
                "peer_send",
                json!({"requestId":"short-mail","toAgentId":"b","taskId":uuid,"body":body}),
            )
            .unwrap();
        assert_eq!(
            retried["message"], message,
            "UUID and short-number retries are one request"
        );
        let reply = store.collaboration_call(Some("b"), "peer_send", json!({"requestId":"reply","toAgentId":"a","taskId":uuid,"replyTo":message["id"],"body":"Reviewed the same task."})).unwrap()["message"].clone();
        assert_eq!(reply["taskId"], "T-1");
        let followup = store.collaboration_call(Some("a"), "peer_send", json!({"requestId":"followup","toAgentId":"b","taskId":"T-1","replyTo":reply["id"],"body":"One question about the result."})).unwrap();
        assert_eq!(followup["message"]["taskId"], "T-1");
        let other = store
            .collaboration_call(
                None,
                "task_create",
                json!({"requestId":"other-task","title":"Another independent outcome"}),
            )
            .unwrap();
        assert_eq!(other["task"]["id"], "T-2");
        assert!(store.collaboration_call(Some("b"), "peer_send", json!({"requestId":"wrong-reference","toAgentId":"a","taskId":"T-2","replyTo":message["id"],"body":"A different goal"})).unwrap_err().to_string().starts_with("invalid_reply:"));
        let inbox = store
            .collaboration_call(None, "peer_read", json!({}))
            .unwrap();
        assert_eq!(inbox["messages"].as_array().unwrap().len(), 3);
        assert!(inbox["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["taskId"] == "T-1"));
        let detail = get(&store, &json!("T-1"));
        assert!(detail["activities"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["taskId"] == "T-1"));
        let db = store.db.read().unwrap();
        let relationships: Vec<String> = db
            .prepare("SELECT DISTINCT json_extract(data,'$.taskId') FROM collaboration_messages")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(|row| row.unwrap())
            .collect();
        assert_eq!(
            relationships,
            vec![uuid],
            "aliases never become separate stored relationships"
        );
    }

    #[test]
    fn opening_an_old_database_projects_uuid_receipts_without_rewriting_authored_content() {
        let (dir, store) = fixture();
        let create_input =
            json!({"requestId":"old-create","title":"Keep historical collaboration readable"});
        let (uuid, old_message_id, authored_body, old_result, raw_receipt) = {
            // Seed the exact pre-short-number representation: UUID snapshots,
            // UUID relationship columns, and UUID idempotency response JSON.
            let db = store.db.write().unwrap();
            let (user, source) = actor_context(&store, &db, None).unwrap();
            let mut created = task_create(&store, &db, &user, &source, &create_input).unwrap();
            let uuid = created["task"]["id"].as_str().unwrap().to_owned();
            let result = json!({"summary":format!("Recorded ID: {uuid}"),
                "links":[{"label":uuid,"url":format!("https://example.com/results/{uuid}"),"id":uuid,"taskId":uuid}],
                "reportedAt":"historical","reportedBy":{"kind":"user","id":"user","name":"You"},"source":null});
            created["task"]["result"] = result.clone();
            db.execute(
                "UPDATE collaboration_tasks SET data=?1 WHERE id=?2",
                params![created["task"].to_string(), uuid],
            )
            .unwrap();
            db.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES('user','task_create','old-create',?1,?2)", params![create_input.to_string(),created.to_string()]).unwrap();
            let body = format!(
                "A historical body containing {{\"id\":\"{uuid}\",\"taskId\":\"{uuid}\"}}."
            );
            let mail_input =
                json!({"requestId":"old-mail","toAgentId":"b","taskId":uuid,"body":body});
            let (author, source) = actor_context(&store, &db, Some("a")).unwrap();
            let mut message = create_message(&store, &db, &author, &source, &mail_input).unwrap();
            message.as_object_mut().unwrap().remove("priority");
            db.execute(
                "UPDATE collaboration_messages SET data=?1 WHERE id=?2",
                params![message.to_string(), message["id"].as_str()],
            )
            .unwrap();
            let response = json!({"message":message});
            db.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES('agent:a','peer_send','old-mail',?1,?2)", params![mail_input.to_string(),response.to_string()]).unwrap();
            (
                uuid,
                message["id"].clone(),
                body,
                result,
                created.to_string(),
            )
        };
        drop(store);
        let store = Store::open(&dir.path().join("workspace.db")).unwrap();
        let list = store
            .collaboration_call(None, "task_list", json!({}))
            .unwrap();
        assert_eq!(list["tasks"][0]["id"], "T-1");
        assert_eq!(
            list["tasks"][0]["result"], old_result,
            "do not recursively rewrite arbitrary links, result content, or author IDs"
        );
        let cached = store
            .collaboration_call(None, "task_create", create_input)
            .unwrap();
        assert_eq!(cached["task"]["id"], "T-1");
        assert_eq!(cached["activity"]["taskId"], "T-1");
        assert_eq!(cached["task"]["result"], old_result);
        for reference in [uuid.as_str(), "T-1"] {
            let retry = store.collaboration_call(Some("a"), "peer_send", json!({"requestId":"old-mail","toAgentId":"b","taskId":reference,"body":authored_body})).unwrap();
            assert_eq!(retry["message"]["id"], old_message_id);
            assert_eq!(retry["message"]["taskId"], "T-1");
            assert_eq!(retry["message"]["body"], authored_body);
            assert_eq!(retry["message"]["priority"], "normal");
        }
        let historical = get(&store, &json!(uuid));
        assert_eq!(historical["task"]["id"], "T-1");
        assert_eq!(historical["activities"][0]["taskId"], "T-1");
        let inbox = store
            .collaboration_call(None, "peer_read", json!({}))
            .unwrap();
        assert_eq!(inbox["messages"].as_array().unwrap().len(), 1);
        assert_eq!(inbox["messages"][0]["body"], authored_body);
        let db = store.db.read().unwrap();
        let still_raw: String = db.query_row("SELECT response_json FROM collaboration_requests WHERE actor='user' AND request_id='old-create'", [], |r| r.get(0)).unwrap();
        assert_eq!(
            still_raw, raw_receipt,
            "upgrade projects historical receipts; it does not rewrite evidence"
        );
    }

    #[test]
    fn task_numbers_survive_restart_and_never_reuse_a_sequence_gap() {
        let (dir, store) = fixture();
        let first = create(&store);
        let second = store
            .collaboration_call(
                None,
                "task_create",
                json!({"requestId":"second","title":"Second deliverable"}),
            )
            .unwrap();
        assert_eq!(first["id"], "T-1");
        assert_eq!(second["task"]["id"], "T-2");
        // There is no application delete command. A direct removal still cannot
        // cause SQLite AUTOINCREMENT to assign the old public number again.
        store
            .db
            .write()
            .unwrap()
            .execute("DELETE FROM collaboration_tasks WHERE seq=2", [])
            .unwrap();
        drop(store);
        let store = Store::open(&dir.path().join("workspace.db")).unwrap();
        let third = store
            .collaboration_call(
                None,
                "task_create",
                json!({"requestId":"third","title":"Third deliverable"}),
            )
            .unwrap();
        assert_eq!(third["task"]["id"], "T-3");
        assert!(store
            .collaboration_call(None, "task_get", json!({"taskId":"T-2"}))
            .is_err());
        let page = store
            .collaboration_call(None, "task_list", json!({"limit":1}))
            .unwrap();
        assert_eq!(page["tasks"][0]["id"], "T-1");
        assert_eq!(page["nextAfterSeq"], 1);
        assert_eq!(page["hasMore"], true);
        let next = store
            .collaboration_call(
                None,
                "task_list",
                json!({"afterSeq":page["nextAfterSeq"],"limit":1}),
            )
            .unwrap();
        assert_eq!(next["tasks"][0]["id"], "T-3");
        assert_eq!(next["nextAfterSeq"], 3);
        assert_eq!(next["hasMore"], false);
        store.collaboration_call(None, "task_update", json!({"requestId":"archive-first","taskId":"T-1","expectedVersion":1,"patch":{"archived":true}})).unwrap();
        let fourth = store
            .collaboration_call(
                None,
                "task_create",
                json!({"requestId":"fourth","title":"Fourth deliverable"}),
            )
            .unwrap();
        assert_eq!(fourth["task"]["id"], "T-4");
        assert_eq!(
            store
                .collaboration_call(None, "task_list", json!({"archived":true}))
                .unwrap()["tasks"][0]["id"],
            "T-1"
        );
    }

    #[test]
    fn dispatch_and_every_task_command_use_the_returned_short_reference() {
        let (_dir, store) = fixture();
        create(&store);
        for invalid in [
            "T-0",
            "T-01",
            "T--1",
            "T-+1",
            "T-1.0",
            "T-9223372036854775808",
        ] {
            assert!(store
                .collaboration_call(None, "task_get", json!({"taskId":invalid}))
                .is_err());
        }
        let claimed = store
            .collaboration_call(
                Some("a"),
                "task_claim",
                json!({"requestId":"claim-short","taskId":"T-1","expectedVersion":1,"start":true}),
            )
            .unwrap();
        assert_eq!(claimed["task"]["id"], "T-1");
        assert_eq!(claimed["activity"]["taskId"], "T-1");
        let dispatched = store.collaboration_call(None, "task_dispatch", json!({"requestId":"dispatch-short","taskId":"T-1","expectedVersion":2,"toAgentId":"b"})).unwrap();
        assert_eq!(dispatched["task"]["id"], "T-1");
        assert_eq!(dispatched["message"]["taskId"], "T-1");
        assert_eq!(dispatched["activity"]["taskId"], "T-1");
        assert!(dispatched["message"]["body"]
            .as_str()
            .unwrap()
            .contains("task T-1:"));
        assert!(!dispatched["message"]["body"]
            .as_str()
            .unwrap()
            .contains(&internal_id(&store, 1)));
        let result = store.collaboration_call(Some("b"), "task_submit_result", json!({"requestId":"result-short","taskId":"T-1","expectedVersion":3,"dispatchId":dispatched["message"]["dispatchId"],"summary":"The original goal is ready for review."})).unwrap();
        assert_eq!(result["task"]["id"], "T-1");
        assert_eq!(result["activity"]["taskId"], "T-1");
        let uuid = internal_id(&store, 1);
        let update = json!({"requestId":"mixed-version","taskId":uuid,"expectedVersion":4,"patch":{"progress":"One final check."}});
        let updated = store
            .collaboration_call(None, "task_update", update.clone())
            .unwrap();
        let mut retry = update;
        retry["taskId"] = json!("T-1");
        assert_eq!(
            store
                .collaboration_call(None, "task_update", retry.clone())
                .unwrap(),
            updated
        );
        retry["patch"]["progress"] = json!("A different intention.");
        assert!(store
            .collaboration_call(None, "task_update", retry)
            .unwrap_err()
            .to_string()
            .starts_with("idempotency_conflict:"));
        assert_eq!(get(&store, &json!("T-1"))["task"]["version"], 5);
        for tool in tool_definitions() {
            if tool["inputSchema"]["properties"].get("taskId").is_some() {
                assert!(tool["inputSchema"]["properties"]["taskId"]["description"]
                    .as_str()
                    .unwrap()
                    .contains("T-1"));
            }
        }
    }

    #[test]
    fn urgent_batches_and_filtered_pages_do_not_reserve_or_fetch_normal_mail() {
        let (_dir, store) = fixture();
        create(&store);
        let mut mail = Vec::new();
        for (i, priority) in ["normal", "urgent", "normal", "urgent"]
            .into_iter()
            .enumerate()
        {
            mail.push(store.collaboration_call(Some("a"), "peer_send", json!({"requestId":format!("priority-{i}"),"toAgentId":"b","taskId":"T-1","priority":priority,"body":format!("Message {i}")})).unwrap()["message"].clone());
        }
        let batches = store.pending_peer_deliveries().unwrap();
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[0]["priority"], "urgent");
        assert_eq!(batches[0]["messageCount"], 2);
        assert_eq!(batches[0]["afterSeq"], mail[1]["seq"].as_i64().unwrap() - 1);
        assert_eq!(batches[0]["throughSeq"], mail[3]["seq"]);
        assert_eq!(batches[1]["priority"], "normal");
        assert_eq!(batches[1]["afterSeq"], mail[0]["seq"].as_i64().unwrap() - 1);
        let through = batches[0]["throughSeq"].as_i64().unwrap();
        assert_eq!(
            store
                .set_peer_delivery_for_priority("b", through, "urgent", "sending", json!({}))
                .unwrap(),
            2
        );
        let first = store
            .collaboration_call(
                Some("b"),
                "peer_read",
                json!({"priority":"urgent","afterSeq":batches[0]["afterSeq"],"limit":1}),
            )
            .unwrap();
        assert_eq!(first["messages"][0]["id"], mail[1]["id"]);
        assert_eq!(first["hasMore"], true);
        let retry = store
            .collaboration_call(
                Some("b"),
                "peer_read",
                json!({"priority":"urgent","afterSeq":batches[0]["afterSeq"],"limit":1}),
            )
            .unwrap();
        assert_eq!(retry, first);
        let second = store
            .collaboration_call(
                Some("b"),
                "peer_read",
                json!({"priority":"urgent","afterSeq":first["nextAfterSeq"],"limit":1}),
            )
            .unwrap();
        assert_eq!(second["messages"][0]["id"], mail[3]["id"]);
        assert_eq!(second["hasMore"], false);
        assert_eq!(
            store
                .set_peer_delivery_for_priority(
                    "b",
                    through,
                    "urgent",
                    "delivered",
                    json!({"agentId":"b","turnId":"urgent-turn","sessionId":"session-b"})
                )
                .unwrap(),
            2
        );
        let normal = store
            .collaboration_call(
                None,
                "peer_read",
                json!({"agentId":"b","priority":"normal"}),
            )
            .unwrap();
        assert_eq!(normal["messages"].as_array().unwrap().len(), 2);
        assert!(normal["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["firstReadAt"].is_null() && m["delivery"]["state"] == "pending"));
        let remaining = store.pending_peer_deliveries().unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0]["priority"], "normal");
        assert_eq!(remaining[0]["messageCount"], 2);
        // The compatibility wrapper touches normal only, even through a later
        // urgent sequence. It cannot overwrite the urgent delivery receipt.
        assert_eq!(
            store
                .set_peer_delivery("b", through, "sending", json!({}))
                .unwrap(),
            2
        );
        let all = store
            .collaboration_call(None, "peer_read", json!({"agentId":"b"}))
            .unwrap();
        assert_eq!(
            all["messages"].as_array().unwrap().len(),
            4,
            "omitting priority intentionally reads both classes"
        );
        assert_eq!(all["messages"][1]["delivery"]["state"], "delivered");
        assert_eq!(all["messages"][3]["delivery"]["state"], "delivered");
        assert_eq!(all["messages"][0]["delivery"]["state"], "sending");
        assert_eq!(all["messages"][2]["delivery"]["state"], "sending");
    }

    #[test]
    fn default_normal_legacy_receipts_and_urgent_dispatch_remain_distinct() {
        let (dir, store) = fixture();
        let first = send(&store, "default-normal", "b");
        assert_eq!(first["priority"], "normal");
        let explicit = store.collaboration_call(Some("a"), "peer_send", json!({"requestId":"default-normal","toAgentId":"b","body":"Review note default-normal","priority":"normal"})).unwrap();
        assert_eq!(explicit["message"], first);
        assert!(store.collaboration_call(Some("a"), "peer_send", json!({"requestId":"default-normal","toAgentId":"b","body":"Review note default-normal","priority":"urgent"})).unwrap_err().to_string().starts_with("idempotency_conflict:"));
        for priority in [json!("high"), json!(null), json!(1)] {
            assert!(store.collaboration_call(Some("a"), "peer_send", json!({"requestId":"invalid-priority","toAgentId":"b","body":"Do not create","priority":priority})).is_err());
            assert!(store
                .collaboration_call(Some("b"), "peer_read", json!({"priority":priority}))
                .is_err());
        }
        create(&store);
        let dispatch = store.collaboration_call(None, "task_dispatch", json!({"requestId":"urgent-dispatch","taskId":"T-1","expectedVersion":1,"toAgentId":"b","priority":"urgent"})).unwrap();
        assert_eq!(dispatch["message"]["priority"], "urgent");
        let through = dispatch["message"]["seq"].as_i64().unwrap();
        store
            .set_peer_delivery_for_priority("b", through, "urgent", "sending", json!({}))
            .unwrap();
        drop(store);
        let store = Store::open(&dir.path().join("workspace.db")).unwrap();
        let all = store
            .collaboration_call(None, "peer_read", json!({"agentId":"b"}))
            .unwrap();
        assert_eq!(all["messages"][0]["priority"], "normal");
        assert_eq!(all["messages"][0]["delivery"]["state"], "pending");
        assert_eq!(all["messages"][1]["priority"], "urgent");
        assert_eq!(all["messages"][1]["delivery"]["state"], "uncertain");
        let batches = store.pending_peer_deliveries().unwrap();
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0]["priority"], "normal");
        assert_eq!(batches[0]["messageCount"], 1);
        assert_eq!(
            get(&store, &json!("T-1"))["task"]["version"],
            2,
            "restarting and notifications do not change task state"
        );
    }

    fn send(store: &Store, key: &str, to: &str) -> Value {
        store
            .collaboration_call(
                Some("a"),
                "peer_send",
                json!({"requestId":key,"toAgentId":to,"body":format!("Review note {key}")}),
            )
            .unwrap()["message"]
            .clone()
    }

    #[test]
    fn fifty_native_turns_and_plans_cannot_pollute_or_complete_shared_tasks() {
        let (_dir, store) = fixture();
        let original = create(&store);
        for n in 0..50 {
            let turn = format!("turn-{n}");
            let events = [
                (
                    "turn/started",
                    json!({"turn":{"id":turn,"status":"inProgress","items":[]}}),
                ),
                (
                    "item/started",
                    json!({"turnId":turn,"item":{"id":format!("tool-{n}"),"type":"commandExecution","command":"test"}}),
                ),
                (
                    "turn/plan/updated",
                    json!({"turnId":turn,"plan":(0..10).map(|i| json!({"step":format!("Step {i}"),"status":"completed"})).collect::<Vec<_>>()}),
                ),
                (
                    "turn/completed",
                    json!({"turn":{"id":turn,"status":"completed","items":[]}}),
                ),
                ("runtime/error", json!({"message":"temporary disconnect"})),
                ("workspace/reconnected", json!({})),
            ];
            for (method, payload) in events {
                store
                    .update("a", method, &payload, |d| d.apply(method, &payload))
                    .unwrap();
            }
        }
        let list = store
            .collaboration_call(None, "task_list", json!({}))
            .unwrap();
        assert_eq!(list["tasks"], json!([original.clone()]));
        let detail = get(&store, &original["id"]);
        assert_eq!(
            detail["task"], original,
            "no native event changes title, definition, version, order or timestamps"
        );
        assert_eq!(detail["activities"].as_array().unwrap().len(), 1);
        assert_eq!(
            detail["executions"],
            json!([]),
            "unrelated Turns cannot inherit a task from an Agent"
        );
    }

    #[test]
    fn atomic_claim_has_one_winner_but_other_agents_can_collaborate() {
        let (_dir, store) = fixture();
        let task = create(&store);
        let store = Arc::new(store);
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = ["a","b"].into_iter().map(|id| {
            let store = store.clone(); let barrier = barrier.clone(); let task = task.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store.collaboration_call(Some(id), "task_claim", json!({"requestId":"claim","taskId":task["id"],"expectedVersion":1,"start":true}))
            })
        }).collect();
        let results: Vec<_> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        let claimed = get(&store, &task["id"])["task"].clone();
        assert_eq!(claimed["status"], "doing");
        assert_eq!(claimed["version"], 2);
        let other = if claimed["assigneeAgentId"] == "a" {
            "b"
        } else {
            "a"
        };
        let commented = store.collaboration_call(Some(other), "task_comment", json!({"requestId":"comment","taskId":task["id"],"body":"I will check the narrow viewport."})).unwrap();
        assert_eq!(
            commented["task"], claimed,
            "comments do not consume a semantic version or reorder cards"
        );
        let result = store.collaboration_call(Some(other), "task_submit_result", json!({"requestId":"result","taskId":task["id"],"expectedVersion":2,"summary":"Narrow viewport verified; ready for your check."})).unwrap();
        assert_eq!(result["task"]["version"], 3);
        assert_eq!(result["task"]["status"], "review");
        assert_eq!(result["task"]["result"]["reportedBy"]["id"], other);
        assert_eq!(
            result["task"]["assigneeAgentId"],
            claimed["assigneeAgentId"]
        );
    }

    #[test]
    fn request_retries_are_exact_and_conflicts_roll_back() {
        let (_dir, store) = fixture();
        let payload = json!({"requestId":"same","title":"A stable deliverable"});
        let first = store
            .collaboration_call(Some("a"), "task_create", payload.clone())
            .unwrap();
        let retry = store
            .collaboration_call(Some("a"), "task_create", payload)
            .unwrap();
        assert_eq!(first, retry);
        let conflict = store
            .collaboration_call(
                Some("a"),
                "task_create",
                json!({"requestId":"same","title":"A different deliverable"}),
            )
            .unwrap_err();
        assert!(conflict.to_string().starts_with("idempotency_conflict:"));
        let update = json!({"requestId":"update","taskId":first["task"]["id"],"expectedVersion":1,"patch":{"progress":"Implementation ready"}});
        let updated = store
            .collaboration_call(None, "task_update", update.clone())
            .unwrap();
        assert_eq!(
            store
                .collaboration_call(None, "task_update", update)
                .unwrap(),
            updated
        );
        let stale = store.collaboration_call(None, "task_update", json!({"requestId":"stale","taskId":first["task"]["id"],"expectedVersion":1,"patch":{"title":"Overwrite"}})).unwrap_err();
        assert!(stale.to_string().starts_with("version_conflict:"));
        assert_eq!(
            get(&store, &first["task"]["id"])["task"]["title"],
            "A stable deliverable"
        );
        // requestId is scoped to actor and operation, not globally reserved.
        store
            .collaboration_call(
                Some("b"),
                "task_create",
                json!({"requestId":"same","title":"A separate deliverable"}),
            )
            .unwrap();
        assert_eq!(
            store
                .collaboration_call(None, "task_list", json!({}))
                .unwrap()["tasks"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn retried_paginated_reads_never_skip_messages_or_forge_understanding() {
        let (_dir, store) = fixture();
        let first = send(&store, "one", "b");
        let second = send(&store, "two", "b");
        let gui = store
            .collaboration_call(None, "peer_read", json!({"agentId":"b","limit":1}))
            .unwrap();
        assert!(
            gui["messages"][0]["firstReadAt"].is_null(),
            "viewing the GUI is not Agent retrieval"
        );
        let read = store
            .collaboration_call(Some("b"), "peer_read", json!({"afterSeq":0,"limit":1}))
            .unwrap();
        assert_eq!(read["messages"][0]["id"], first["id"]);
        assert_eq!(read["hasMore"], true);
        assert!(read["messages"][0]["firstReadAt"].is_string());
        assert_eq!(
            read["messages"][0]["delivery"]["state"], "pending",
            "retrieval is independent of native notification delivery"
        );
        let retried = store
            .collaboration_call(Some("b"), "peer_read", json!({"afterSeq":0,"limit":1}))
            .unwrap();
        assert_eq!(
            retried, read,
            "a lost response is safe to retry, including its first-read evidence"
        );
        let page2 = store
            .collaboration_call(
                Some("b"),
                "peer_read",
                json!({"afterSeq":read["nextAfterSeq"],"limit":1}),
            )
            .unwrap();
        assert_eq!(page2["messages"][0]["id"], second["id"]);
        assert_eq!(page2["hasMore"], false);
        assert!(store
            .collaboration_call(Some("c"), "peer_read", json!({"agentId":"b"}))
            .is_err());
        let count: i64 = store
            .db
            .read()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM collaboration_message_reads",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn actor_identity_reply_chain_and_task_context_are_server_owned() {
        let (_dir, store) = fixture();
        let task = create(&store);
        let input = json!({"requestId":"first","toAgentId":"b","body":"Please review the result","taskId":task["id"]});
        let message = store
            .collaboration_call(Some("a"), "peer_send", input.clone())
            .unwrap()["message"]
            .clone();
        assert_eq!(message["sender"]["id"], "a");
        assert_eq!(message["source"]["agentId"], "a");
        let mut spoof = input.clone();
        spoof["requestId"] = json!("spoof");
        spoof["sender"] = json!({"id":"c"});
        assert!(store
            .collaboration_call(Some("a"), "peer_send", spoof)
            .is_err());
        let reply = store.collaboration_call(Some("b"), "peer_send", json!({"requestId":"reply","toAgentId":"a","body":"Reviewed","replyTo":message["id"]})).unwrap()["message"].clone();
        assert_eq!(reply["taskId"], task["id"]);
        assert_eq!(reply["threadId"], message["threadId"]);
        assert!(store.collaboration_call(Some("c"), "peer_send", json!({"requestId":"intrude","toAgentId":"a","body":"Forged reply","replyTo":message["id"]})).is_err());
        let other = store
            .collaboration_call(
                None,
                "task_create",
                json!({"requestId":"other","title":"Other goal"}),
            )
            .unwrap();
        assert!(store.collaboration_call(Some("b"), "peer_send", json!({"requestId":"wrong-task","toAgentId":"a","body":"Wrong task","replyTo":message["id"],"taskId":other["task"]["id"]})).is_err());
        // A GUI user can reply on an observed thread without impersonating either Agent.
        let user = store.collaboration_call(None, "peer_send", json!({"requestId":"user-reply","toAgentId":"a","body":"Please revise this","replyTo":message["id"]})).unwrap();
        assert_eq!(user["message"]["sender"]["kind"], "user");
        assert!(store
            .collaboration_call(Some("missing"), "peers_list", json!({}))
            .is_err());
    }

    #[test]
    fn dispatch_is_atomic_idempotent_and_does_not_start_a_runtime() {
        let (_dir, store) = fixture();
        let task = create(&store);
        let invalid = json!({"requestId":"dispatch","taskId":task["id"],"expectedVersion":1,"toAgentId":"missing"});
        assert!(store
            .collaboration_call(None, "task_dispatch", invalid)
            .is_err());
        assert_eq!(get(&store, &task["id"])["task"], task);
        assert_eq!(
            store
                .collaboration_call(None, "peer_read", json!({}))
                .unwrap()["messages"],
            json!([])
        );
        let input =
            json!({"requestId":"dispatch","taskId":task["id"],"expectedVersion":1,"toAgentId":"b"});
        let dispatched = store
            .collaboration_call(None, "task_dispatch", input.clone())
            .unwrap();
        assert_eq!(dispatched["task"]["assigneeAgentId"], "b");
        assert_eq!(dispatched["task"]["status"], "doing");
        assert_eq!(dispatched["message"]["taskId"], task["id"]);
        assert_eq!(
            store
                .collaboration_call(None, "task_dispatch", input)
                .unwrap(),
            dispatched
        );
        assert_eq!(store.detail("b").unwrap().agent.status, "idle");
        assert!(store.detail("b").unwrap().turns.is_empty());
        assert_eq!(
            store.pending_peer_deliveries().unwrap()[0]["messageCount"],
            1
        );
    }

    #[test]
    fn notification_batches_never_retry_uncertain_messages_or_capture_later_mail() {
        let (_dir, store) = fixture();
        let first = send(&store, "first", "b");
        let seq1 = first["seq"].as_i64().unwrap();
        assert_eq!(
            store.pending_peer_deliveries().unwrap()[0]["afterSeq"],
            seq1 - 1
        );
        store
            .set_peer_delivery("b", seq1, "sending", json!({}))
            .unwrap();
        let next = send(&store, "next", "b");
        let seq2 = next["seq"].as_i64().unwrap();
        store
            .set_peer_delivery("b", seq1, "uncertain", json!({"reason":"connection_lost"}))
            .unwrap();
        assert_eq!(
            store.pending_peer_deliveries().unwrap()[0]["throughSeq"],
            seq2
        );
        assert_eq!(
            store.pending_peer_deliveries().unwrap()[0]["afterSeq"],
            seq1 - 1 // A new notice also exposes previously unfetched mail, without replaying its native input.
        );
        store
            .set_peer_delivery("b", seq2, "sending", json!({}))
            .unwrap();
        store
            .set_peer_delivery(
                "b",
                seq2,
                "delivered",
                json!({"turnId":"turn-b","agentId":"b","sessionId":"session-b"}),
            )
            .unwrap();
        assert!(store.pending_peer_deliveries().unwrap().is_empty());
        let inbox = store
            .collaboration_call(None, "peer_read", json!({"agentId":"b"}))
            .unwrap();
        assert_eq!(inbox["messages"][0]["delivery"]["state"], "uncertain");
        assert_eq!(inbox["messages"][1]["delivery"]["state"], "delivered");
        store
            .set_peer_delivery("b", seq2, "pending", json!({}))
            .unwrap();
        assert!(
            store.pending_peer_deliveries().unwrap().is_empty(),
            "explicit retry cannot reset delivered or unknown outcomes"
        );
    }

    #[test]
    fn agent_fetch_suppresses_a_later_doorbell_without_claiming_completion() {
        let (_dir, store) = fixture();
        let message = send(&store, "already-fetched", "b");
        let seq = message["seq"].as_i64().unwrap();
        assert_eq!(store.pending_peer_deliveries().unwrap().len(), 1);
        store
            .collaboration_call(Some("b"), "peer_read", json!({}))
            .unwrap();
        assert!(store.pending_peer_deliveries().unwrap().is_empty());
        // Covers a race where the runtime took its pending snapshot before read.
        let reserved = store
            .set_peer_delivery("b", seq, "sending", json!({}))
            .unwrap();
        assert_eq!(
            reserved, 0,
            "the runtime must not send an empty doorbell batch"
        );
        let read = store
            .collaboration_call(None, "peer_read", json!({"agentId":"b"}))
            .unwrap();
        assert_eq!(read["messages"][0]["delivery"]["state"], "pending");
        assert!(read["messages"][0]["firstReadAt"].is_string());
        assert_eq!(store.detail("b").unwrap().agent.status, "idle");
        let next = send(&store, "fresh", "b");
        let batch = store.pending_peer_deliveries().unwrap();
        assert_eq!(batch[0]["messageCount"], 1);
        assert_eq!(batch[0]["afterSeq"], next["seq"].as_i64().unwrap() - 1);
    }

    #[test]
    fn restart_preserves_receipts_and_marks_only_inflight_notifications_uncertain() {
        let (dir, store) = fixture();
        let task = create(&store);
        let message = send(&store, "durable", "b");
        let seq = message["seq"].as_i64().unwrap();
        store
            .set_peer_delivery("b", seq, "sending", json!({}))
            .unwrap();
        let read = store
            .collaboration_call(Some("b"), "peer_read", json!({}))
            .unwrap();
        drop(store);
        let store = Store::open(&dir.path().join("workspace.db")).unwrap();
        let inbox = store
            .collaboration_call(Some("b"), "peer_read", json!({}))
            .unwrap();
        assert_eq!(inbox["messages"][0]["delivery"]["state"], "uncertain");
        assert_eq!(
            inbox["messages"][0]["firstReadAt"],
            read["messages"][0]["firstReadAt"]
        );
        assert!(store.pending_peer_deliveries().unwrap().is_empty());
        assert_eq!(
            create(&store),
            task,
            "create retry remains idempotent after Core restart"
        );
        let retried = send(&store, "durable", "b");
        assert_eq!(retried["id"], message["id"]);
        assert!(store.pending_peer_deliveries().unwrap().is_empty());
    }

    #[test]
    fn deleting_agents_preserves_tasks_authors_messages_results_and_activity() {
        let (_dir, store) = fixture();
        let task = store
            .collaboration_call(
                Some("a"),
                "task_create",
                json!({"requestId":"create","title":"A durable outcome","assigneeAgentId":"a"}),
            )
            .unwrap()["task"]
            .clone();
        let message = send(&store, "history", "b");
        let result = store.collaboration_call(Some("a"), "task_submit_result", json!({"requestId":"result","taskId":task["id"],"expectedVersion":1,"summary":"Ready for review"})).unwrap();
        store
            .update("a", "renamed", &json!({}), |d| {
                d.agent.name = "A different name".into()
            })
            .unwrap();
        store
            .update("a", "closed", &json!({}), |d| {
                d.agent.closed_at = Some(now())
            })
            .unwrap();
        store.delete_closed_agent("a").unwrap();
        store
            .update("b", "closed", &json!({}), |d| {
                d.agent.closed_at = Some(now())
            })
            .unwrap();
        store.delete_closed_agent("b").unwrap();
        let historical = get(&store, &task["id"]);
        assert_eq!(historical["task"], result["task"]);
        assert_eq!(historical["task"]["createdBy"]["name"], "Agent a");
        assert_eq!(
            historical["task"]["result"]["reportedBy"]["name"],
            "Agent a"
        );
        assert_eq!(historical["activities"].as_array().unwrap().len(), 2);
        let inbox = store
            .collaboration_call(None, "peer_read", json!({"agentId":"b"}))
            .unwrap();
        assert_eq!(inbox["messages"][0]["id"], message["id"]);
        assert_eq!(inbox["messages"][0]["sender"]["name"], "Agent a");
        assert!(store.pending_peer_deliveries().unwrap().is_empty());
    }

    #[test]
    fn one_task_can_link_multiple_agents_and_turns_without_agent_wide_inheritance() {
        let (_dir, store) = fixture();
        let task = create(&store);
        store
            .update("a", "turn/started", &json!({}), |d| {
                d.turns
                    .push(json!({"id":"turn-a","status":"inProgress","items":[]}));
            })
            .unwrap();
        store
            .collaboration_call(
                Some("a"),
                "task_comment",
                json!({"requestId":"progress","taskId":task["id"],"body":"Implementation ready."}),
            )
            .unwrap();
        store
            .collaboration_call(
                Some("a"),
                "task_comment",
                json!({"requestId":"progress-2","taskId":task["id"],"body":"Tests pass."}),
            )
            .unwrap();
        let dispatch = store.collaboration_call(None, "task_dispatch", json!({"requestId":"review","taskId":task["id"],"expectedVersion":1,"toAgentId":"b"})).unwrap();
        let through = dispatch["message"]["seq"].as_i64().unwrap();
        store
            .set_peer_delivery("b", through, "sending", json!({}))
            .unwrap();
        store
            .set_peer_delivery(
                "b",
                through,
                "delivered",
                json!({"agentId":"b","turnId":"turn-b","sessionId":"session-b"}),
            )
            .unwrap();
        let executions = get(&store, &task["id"])["executions"].clone();
        assert_eq!(
            executions,
            json!([
                {"agentId":"a","turnId":"turn-a","sessionId":"session-a"},
                {"agentId":"b","turnId":"turn-b","sessionId":"session-b"}
            ])
        );
        let other = store
            .collaboration_call(
                None,
                "task_create",
                json!({"requestId":"other","title":"Another independent goal"}),
            )
            .unwrap();
        assert_eq!(get(&store, &other["task"]["id"])["executions"], json!([]));
    }

    #[test]
    fn task_filters_and_comment_pagination_use_stable_sequences() {
        let (_dir, store) = fixture();
        let first = create(&store);
        let second = store.collaboration_call(None, "task_create", json!({"requestId":"two","title":"Remote reconnect","status":"blocked","assigneeAgentId":"b"})).unwrap()["task"].clone();
        let page = store
            .collaboration_call(None, "task_list", json!({"limit":1}))
            .unwrap();
        assert_eq!(page["tasks"][0]["id"], first["id"]);
        assert_eq!(page["counts"]["todo"], 1);
        assert_eq!(page["counts"]["blocked"], 1);
        assert_eq!(page["hasMore"], true);
        let next = store
            .collaboration_call(None, "task_list", json!({"afterSeq":page["nextAfterSeq"]}))
            .unwrap();
        assert_eq!(next["tasks"][0]["id"], second["id"]);
        let filter = store
            .collaboration_call(
                None,
                "task_list",
                json!({"query":"reconnect","assigneeAgentId":"b","status":"blocked"}),
            )
            .unwrap();
        assert_eq!(filter["tasks"], json!([second]));
        for i in 0..3 {
            store.collaboration_call(None, "task_comment", json!({"requestId":format!("comment-{i}"),"taskId":first["id"],"body":format!("Note {i}")})).unwrap();
        }
        let page = store
            .collaboration_call(None, "task_get", json!({"taskId":first["id"],"limit":2}))
            .unwrap();
        assert_eq!(page["activities"].as_array().unwrap().len(), 2);
        assert_eq!(page["hasMore"], true);
        let page2 = store
            .collaboration_call(
                None,
                "task_get",
                json!({"taskId":first["id"],"limit":2,"afterSeq":page["nextAfterSeq"]}),
            )
            .unwrap();
        assert_eq!(page2["activities"].as_array().unwrap().len(), 2);
        assert_eq!(page2["hasMore"], false);
        let archived = store.collaboration_call(None, "task_update", json!({"requestId":"archive","taskId":first["id"],"expectedVersion":1,"patch":{"archived":true}})).unwrap();
        assert!(archived["task"]["archivedAt"].is_string());
        assert_eq!(
            store
                .collaboration_call(None, "task_list", json!({"archived":true}))
                .unwrap()["tasks"][0]["id"],
            first["id"]
        );
    }

    #[test]
    fn result_validation_is_atomic_and_cancellation_never_changes_runtime_state() {
        let (_dir, store) = fixture();
        let task = create(&store);
        for url in [
            "javascript:alert(1)",
            "data:text/html,hello",
            "file:///etc/passwd",
        ] {
            assert!(store.collaboration_call(Some("b"), "task_submit_result", json!({"requestId":"result","taskId":task["id"],"expectedVersion":1,"summary":"Review complete","links":[{"label":"Unsafe","url":url}]})).is_err());
        }
        assert_eq!(get(&store, &task["id"])["task"], task);
        store
            .update("a", "turn/started", &json!({}), |d| {
                d.agent.status = "working".into()
            })
            .unwrap();
        let result = store.collaboration_call(None, "task_update", json!({"requestId":"cancel","taskId":task["id"],"expectedVersion":1,"patch":{"status":"cancelled"}})).unwrap();
        assert_eq!(result["task"]["status"], "cancelled");
        assert_eq!(store.detail("a").unwrap().agent.status, "working");
        assert!(store
            .collaboration_call(
                Some("a"),
                "task_claim",
                json!({"requestId":"claim","taskId":task["id"],"expectedVersion":2})
            )
            .is_err());
    }
}
