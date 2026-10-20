use super::{Check, Submit};
use crate::{github::client::Repository, model::now, store::Store};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS pr_operations(
        id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
        repo_id INTEGER NOT NULL,head TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS pr_operations_task ON pr_operations(task_id);
        CREATE UNIQUE INDEX IF NOT EXISTS pr_operations_active ON pr_operations(repo_id,head)
        WHERE status IN ('accepted','running');",
    )?;
    Ok(())
}
fn actor_key(actor: Option<&str>) -> String {
    actor
        .map(|id| format!("agent:{id}"))
        .unwrap_or_else(|| "user".into())
}
fn payload(db: &Connection, operation: &str, task: &str, value: &Value) -> Result<Value> {
    let mut value = if operation == "github_pr_submit" {
        serde_json::to_value(serde_json::from_value::<Submit>(value.clone())?)?
    } else {
        serde_json::to_value(serde_json::from_value::<Check>(value.clone())?)?
    };
    value["taskId"] = json!(crate::collaboration_store::task_key(db, task)?.0);
    Ok(value)
}
fn previous(
    store: &Store,
    db: &Connection,
    actor: Option<&str>,
    operation: &str,
    task: &str,
    key: &str,
    value: &Value,
) -> Result<Option<Value>> {
    crate::collaboration_store::actor_context(store, db, actor)?;
    let expected = payload(db, operation, task, value)?;
    let receipt: Option<(String,String)> = db.query_row(
        "SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation=?2 AND request_id=?3",
        params![actor_key(actor),operation,key], |r| Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((input, response)) = receipt else {
        return Ok(None);
    };
    ensure!(
        serde_json::from_str::<Value>(&input)? == expected,
        "idempotency_conflict: requestId already has another PR operation payload"
    );
    let response: Value = serde_json::from_str(&response)?;
    let raw: String = db.query_row(
        "SELECT data FROM pr_operations WHERE id=?1",
        [response["operationId"]
            .as_str()
            .context("Invalid PR operation receipt")?],
        |r| r.get(0),
    )?;
    Ok(Some(serde_json::from_str(&raw)?))
}
fn receipt(
    db: &Connection,
    actor: Option<&str>,
    operation: &str,
    task: &str,
    key: &str,
    input: &Value,
    id: &str,
) -> Result<()> {
    db.execute("INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,?2,?3,?4,?5)",
        params![actor_key(actor),operation,key,payload(db,operation,task,input)?.to_string(),json!({"operationId":id}).to_string()])?;
    Ok(())
}
fn repositories(db: &Connection, task: &str) -> Result<Vec<Value>> {
    let project: Option<String> = db
        .query_row(
            "SELECT project_id FROM project_tasks WHERE task_id=?1",
            [task],
            |r| r.get(0),
        )
        .optional()?;
    let mut q = db.prepare("SELECT data FROM github_repositories WHERE (?1 IS NULL OR id IN (SELECT repo_id FROM github_project_repos WHERE project_id=?1)) ORDER BY id LIMIT 100")?;
    let result = q
        .query_map([project], |r| r.get::<_, String>(0))?
        .map(|row| Ok(serde_json::from_str(&row?)?))
        .collect();
    result
}
fn require_repository(db: &Connection, task: &str, id: i64) -> Result<Value> {
    repositories(db, task)?
        .into_iter()
        .find(|r| r["id"] == id)
        .context("Link the selected repository in the task's Project settings first")
}
fn require_idle(db: &Connection, repo: i64, head: &str) -> Result<()> {
    let busy: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pr_operations WHERE repo_id=?1 AND head=?2 AND status IN ('accepted','running'))",params![repo,head],|r|r.get(0))?;
    ensure!(
        !busy,
        "A PR operation for this repository/head is already active; inspect it before retrying"
    );
    Ok(())
}

impl Store {
    pub(crate) fn recover_pr_operations(&self) -> Result<()> {
        let pending = {
            let db = self.db.read()?;
            let mut q = db
                .prepare("SELECT data FROM pr_operations WHERE status IN ('accepted','running')")?;
            let rows = q
                .query_map([], |r| r.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        for raw in pending {
            let mut data: Value = serde_json::from_str(&raw)?;
            data["status"] = json!("unknown");
            data["error"] = json!(
                "Core restarted before completion was confirmed. Check GitHub; no remote write was replayed."
            );
            data["finishedAt"] = json!(now());
            self.finish_pr_operation(data)?;
        }
        Ok(())
    }
    pub(super) fn previous_pr_operation(
        &self,
        actor: Option<&str>,
        operation: &str,
        task: &str,
        key: &str,
        input: &Value,
    ) -> Result<Option<Value>> {
        let db = self.db.read()?;
        previous(self, &db, actor, operation, task, key, input)
    }
    pub(super) fn create_pr_operation(
        &self,
        actor: Option<&str>,
        input: Submit,
    ) -> Result<(Value, bool)> {
        input.validate()?;
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let value = serde_json::to_value(&input)?;
        if let Some(old) = previous(
            self,
            &tx,
            actor,
            "github_pr_submit",
            &input.task_id,
            &input.request_id,
            &value,
        )? {
            return Ok((old, false));
        }
        let (author, source) = crate::collaboration_store::actor_context(self, &tx, actor)?;
        let (task, seq) = crate::collaboration_store::task_key(&tx, &input.task_id)?;
        let repo = require_repository(&tx, &task, input.repository_id)?;
        require_idle(&tx, input.repository_id, &input.head)?;
        let count: i64 = tx.query_row(
            "SELECT COUNT(*) FROM pr_operations WHERE task_id=?1",
            [&task],
            |r| r.get(0),
        )?;
        ensure!(
            count < 200,
            "This task has reached its 200-operation history limit"
        );
        ensure!(
            actor.is_none()
                || input
                    .notify_agent_id
                    .as_deref()
                    .is_none_or(|id| Some(id) == actor),
            "MCP PR results notify the requesting Agent"
        );
        let recipient = input
            .notify_agent_id
            .as_deref()
            .or(actor)
            .map(|id| crate::collaboration_store::agent_actor(self, &tx, id))
            .transpose()?;
        let id = uuid::Uuid::new_v4().to_string();
        let record = json!({"id":id,"operationId":id,"taskId":task,"taskReference":format!("T-{seq}"),"requestId":input.request_id,
            "input":value,"repositoryId":input.repository_id,"repository":repo["fullName"],"requestedBy":author,"source":source,
            "notificationRecipient":recipient,"status":"accepted","phase":"Checking pushed branches and existing PRs",
            "attempt":1,"history":[],"notificationId":null,"createdAt":now(),"finishedAt":null,
            "writeStarted":false,"remote":null,"linked":false,"error":null,"associationError":null,"candidates":[]});
        tx.execute("INSERT INTO pr_operations(id,task_id,repo_id,head,status,data) VALUES(?1,?2,?3,?4,'accepted',?5)",params![id,task,input.repository_id,input.head,record.to_string()])?;
        receipt(
            &tx,
            actor,
            "github_pr_submit",
            &task,
            &input.request_id,
            &value,
            &id,
        )?;
        crate::collaboration_store::activity(
            &tx,
            &task,
            "comment",
            &author,
            &source,
            json!({"operationId":id,"body":format!("Requested PR {} · {id}. This does not request review, merge or task completion.",input.action)}),
        )?;
        tx.commit()?;
        Ok((record, true))
    }
    pub(super) fn check_pr_operation(
        &self,
        actor: Option<&str>,
        input: Check,
    ) -> Result<(Value, bool)> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let value = serde_json::to_value(&input)?;
        if let Some(old) = previous(
            self,
            &tx,
            actor,
            "github_pr_check",
            &input.task_id,
            &input.request_id,
            &value,
        )? {
            return Ok((old, false));
        }
        let (author, source) = crate::collaboration_store::actor_context(self, &tx, actor)?;
        let task = crate::collaboration_store::task_key(&tx, &input.task_id)?.0;
        let raw: String = tx.query_row(
            "SELECT data FROM pr_operations WHERE id=?1 AND task_id=?2",
            params![input.operation_id, task],
            |r| r.get(0),
        )?;
        let mut data: Value = serde_json::from_str(&raw)?;
        ensure!(
            data["status"] != "accepted" && data["status"] != "running",
            "This operation is still active"
        );
        if let (Some(number), Some(original)) = (input.number, data["input"]["number"].as_u64()) {
            ensure!(
                number == original,
                "The originally selected PR number cannot be changed during recovery"
            );
        }
        receipt(
            &tx,
            actor,
            "github_pr_check",
            &task,
            &input.request_id,
            &value,
            &input.operation_id,
        )?;
        if data["status"] == "completed" {
            tx.commit()?;
            return Ok((data, false));
        }
        if let (Some(number), Some(known)) = (input.number, data["remote"]["number"].as_u64()) {
            ensure!(
                number == known,
                "A confirmed PR identity cannot be replaced by another candidate"
            );
        }
        let repo = data["repositoryId"]
            .as_i64()
            .context("Missing repository identity")?;
        require_repository(&tx, &task, repo)?;
        require_idle(
            &tx,
            repo,
            data["input"]["head"].as_str().context("Missing head")?,
        )?;
        let attempt = data["attempt"].as_u64().context("Missing attempt")?;
        ensure!(
            attempt < 20,
            "This operation has reached its recovery-check limit"
        );
        data["attempt"] = json!(attempt + 1);
        data["status"] = json!("accepted");
        data["phase"] = json!("Checking remote outcome and repairing task link; no write retry");
        data["finishedAt"] = Value::Null;
        data["notificationId"] = Value::Null;
        data["lastCheckBy"] = json!(author);
        data["error"] = Value::Null;
        tx.execute(
            "UPDATE pr_operations SET status='accepted',data=?1 WHERE id=?2",
            params![data.to_string(), input.operation_id],
        )?;
        crate::collaboration_store::activity(
            &tx,
            &task,
            "comment",
            &author,
            &source,
            json!({"operationId":input.operation_id,"body":"Requested a remote PR check/link repair; no create/update replay."}),
        )?;
        tx.commit()?;
        Ok((data, true))
    }
    pub(super) fn progress_pr_operation(&self, data: &Value) -> Result<()> {
        ensure!(
            data["status"] == "running",
            "Only running progress may be saved here"
        );
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let changed = tx.execute("UPDATE pr_operations SET status='running',data=?1 WHERE id=?2 AND status IN ('accepted','running') AND json_extract(data,'$.attempt')=?3",params![data.to_string(),data["id"].as_str(),data["attempt"].as_i64()])?;
        ensure!(changed == 1, "PR operation changed before execution");
        tx.commit()?;
        Ok(())
    }
    pub(super) fn finish_pr_operation(&self, mut data: Value) -> Result<Value> {
        let id = data["id"]
            .as_str()
            .context("Missing operation ID")?
            .to_owned();
        let task = data["taskId"].as_str().context("Missing task")?.to_owned();
        ensure!(
            matches!(
                data["status"].as_str(),
                Some("completed" | "failed" | "unknown" | "needs_selection")
            ),
            "Invalid terminal PR state"
        );
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let current: String =
            tx.query_row("SELECT data FROM pr_operations WHERE id=?1", [&id], |r| {
                r.get(0)
            })?;
        let current: Value = serde_json::from_str(&current)?;
        if !matches!(current["status"].as_str(), Some("accepted" | "running"))
            || current["attempt"] != data["attempt"]
        {
            return Ok(current);
        }
        if data["remote"].is_object() {
            let repo = Repository {
                id: data["repositoryId"].as_i64().context("Missing repo")?,
                full_name: data["repository"]
                    .as_str()
                    .context("Missing repo name")?
                    .into(),
            };
            let number = data["remote"]["number"]
                .as_u64()
                .context("Missing PR number")?;
            let snapshot = super::remote::snapshot(&data["remote"]);
            tx.execute_batch("SAVEPOINT pr_operation_link")?;
            let linked = (|| -> Result<()> {
                crate::github::store::link_object(
                    &tx,
                    &task,
                    &repo,
                    "pull",
                    number,
                    snapshot.clone(),
                )?;
                let observed = snapshot["observedAt"]
                    .as_str()
                    .context("Missing observation time")?;
                let object = format!("{}:pull:{number}", repo.id);
                let cache = json!({"snapshot":snapshot,"syncedAt":now(),"lastAttemptAt":now(),"error":null});
                tx.execute("UPDATE github_objects SET data=?1 WHERE id=?2 AND COALESCE(json_extract(data,'$.snapshot.observedAt'),'')<=?3",params![cache.to_string(),object,observed])?;
                Ok(())
            })();
            match linked {
                Ok(()) => {
                    tx.execute_batch("RELEASE pr_operation_link")?;
                    data["linked"] = json!(true);
                    data["associationError"] = Value::Null;
                }
                Err(error) => {
                    tx.execute_batch("ROLLBACK TO pr_operation_link; RELEASE pr_operation_link")?;
                    data["linked"] = json!(false);
                    data["associationError"] = json!(error.to_string());
                    if data["status"] == "completed" {
                        data["status"] = json!("link_pending");
                    }
                }
            }
        }
        data["phase"] = data["status"].clone();
        let notification = data["notificationRecipient"]
            .is_object()
            .then(|| uuid::Uuid::new_v4().to_string());
        data["notificationId"] = json!(notification);
        let event = json!({"attempt":data["attempt"],"status":data["status"],"finishedAt":data["finishedAt"],"error":data["error"],"associationError":data["associationError"],"notificationId":notification});
        data["history"]
            .as_array_mut()
            .context("Missing operation history")?
            .push(event);
        tx.execute(
            "UPDATE pr_operations SET status=?1,data=?2 WHERE id=?3",
            params![data["status"].as_str(), data.to_string(), id],
        )?;
        let actor = crate::collaboration_store::TaskActor {
            kind: "system".into(),
            id: "core".into(),
            name: "Yuzuno Core".into(),
        };
        let source = json!({"operationId":id,"attempt":data["attempt"]});
        let body = format!(
            "PR operation {id} has ended: {}. Task {}; PR {}. Task association: {}. {}{} Read github_pr_get(taskId={}, operationId={id}) for the retained result. This does not authorize review, merge or task completion.",
            data["status"].as_str().unwrap_or("unknown"),
            data["taskReference"].as_str().unwrap_or(&task),
            data["remote"]["url"].as_str().unwrap_or("not confirmed"),
            if data["linked"] == true {
                "linked"
            } else {
                "not linked"
            },
            data["error"].as_str().unwrap_or(""),
            data["associationError"]
                .as_str()
                .map(|s| format!(" {s}"))
                .unwrap_or_default(),
            data["taskReference"].as_str().unwrap_or(&task)
        );
        if let Some(message_id) = notification {
            // Typed so the mailbox notice reads "PR #n · PR updated" rather
            // than a bare System notice (mailbox_notice.rs).
            let name = data["remote"]["number"]
                .as_u64()
                .map(|n| format!("PR #{n}"))
                .or_else(|| data["repository"].as_str().map(str::to_owned));
            crate::collaboration_store::insert_message(
                &tx,
                json!({"id":message_id,"seq":0,"sender":actor,"recipient":data["notificationRecipient"],"body":body,"taskId":task,"replyTo":null,"threadId":message_id,"createdAt":now(),"source":source,"priority":"normal","operationId":id,
                    "metadata":{"kind":"pr","operationId":id,"status":data["status"],"action":data["input"]["action"],"name":name}}),
            )?;
        }
        crate::collaboration_store::activity(
            &tx,
            &task,
            "comment",
            &actor,
            &source,
            json!({"operationId":id,"body":body}),
        )?;
        tx.commit()?;
        Ok(data)
    }
    pub(super) fn pr_operation(&self, task: &str, id: &str) -> Result<Value> {
        let db = self.db.read()?;
        let task = crate::collaboration_store::task_key(&db, task)?.0;
        let (cursor, raw): (i64, String) = db.query_row(
            "SELECT rowid,data FROM pr_operations WHERE task_id=?1 AND id=?2",
            params![task, id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )?;
        let mut value: Value = serde_json::from_str(&raw)?;
        value["cursor"] = json!(cursor);
        Ok(value)
    }
    pub(super) fn list_pr_operations(
        &self,
        task: &str,
        before: Option<i64>,
        through: Option<i64>,
    ) -> Result<Value> {
        let db = self.db.read()?;
        let task = crate::collaboration_store::task_key(&db, task)?.0;
        let mut q = db.prepare("SELECT rowid,json_remove(data,'$.input.body','$.remote.body','$.history','$.remoteBefore') FROM pr_operations WHERE task_id=?1 AND rowid<?2 AND (?3 IS NULL OR rowid>=?3) ORDER BY rowid DESC LIMIT ?4")?;
        let rows = q.query_map(
            params![
                task,
                before.unwrap_or(i64::MAX),
                through,
                if through.is_some() { 201 } else { 21 }
            ],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)),
        )?;
        let mut records = Vec::new();
        for row in rows {
            let (cursor, raw) = row?;
            let mut data: Value = serde_json::from_str(&raw)?;
            data["cursor"] = json!(cursor);
            records.push(data);
        }
        let more = if through.is_some() {
            let last = records
                .last()
                .and_then(|v| v["cursor"].as_i64())
                .unwrap_or(0);
            db.query_row(
                "SELECT EXISTS(SELECT 1 FROM pr_operations WHERE task_id=?1 AND rowid<?2)",
                params![task, last],
                |r| r.get::<_, bool>(0),
            )?
        } else {
            let more = records.len() > 20;
            records.truncate(20);
            more
        };
        Ok(
            json!({"nextBefore":records.last().map(|r|r["cursor"].clone()),"hasMore":more,"operations":records,"repositories":repositories(&db,&task)?}),
        )
    }
}
