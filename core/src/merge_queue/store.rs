//! Merge entries: what was released, who released it, and every check's
//! outcome. All GitHub I/O happens outside these transactions.
use super::checks::{self, Hold};
use super::{Change, Enqueue, Scope};
use crate::collaboration_store::{self as collab, TaskActor};
use crate::{model::now, store::Store};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

/// Entries that still hold their PR: a second release of it is refused.
const ACTIVE: &str = "('queued','waiting','ready')";
/// A check that has waited this long stops instead (seconds).
const WAIT_LIMIT: i64 = 6 * 3600;
/// Consecutive failed reads before an entry stops.
const READ_FAILURES: i64 = 8;

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS merge_entries(
        id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
        repository_id INTEGER NOT NULL,number INTEGER NOT NULL,state TEXT NOT NULL,
        next_check INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS merge_entries_task ON merge_entries(task_id);
        CREATE INDEX IF NOT EXISTS merge_entries_due ON merge_entries(state,next_check);
        CREATE UNIQUE INDEX IF NOT EXISTS merge_entries_active ON merge_entries(repository_id,number)
        WHERE state IN ('queued','waiting','ready');
        CREATE TABLE IF NOT EXISTS merge_repositories(repository_id INTEGER PRIMARY KEY,data TEXT NOT NULL);",
    )?;
    Ok(())
}

fn system() -> TaskActor {
    TaskActor {
        kind: "system".into(),
        id: "core".into(),
        name: "Yuzuno Core".into(),
    }
}
fn actor_key(actor: Option<&str>) -> String {
    actor.map(|id| format!("agent:{id}")).unwrap_or_else(|| "user".into())
}
fn epoch() -> i64 {
    chrono::Utc::now().timestamp()
}
fn entry(db: &Connection, id: &str) -> Result<Value> {
    let raw: Option<String> = db
        .query_row("SELECT data FROM merge_entries WHERE id=?1", [id], |r| r.get(0))
        .optional()?;
    Ok(serde_json::from_str(&raw.context("merge_entry_not_found: No such merge entry")?)?)
}
fn save(db: &Connection, e: &Value) -> Result<()> {
    db.execute(
        "UPDATE merge_entries SET state=?1,next_check=?2,data=?3 WHERE id=?4",
        params![e["state"].as_str(), e["nextCheck"].as_i64().unwrap_or(0), e.to_string(), e["id"].as_str()],
    )?;
    Ok(())
}
fn history(e: &mut Value, state: &str, reason: &Value, detail: &Value) {
    let item = json!({"at":now(),"state":state,"reason":reason,"detail":detail});
    if let Some(list) = e["history"].as_array_mut() {
        list.push(item);
        let excess = list.len().saturating_sub(50);
        list.drain(..excess);
    }
}

/// A repository's switch, set by the user only (design §2).
fn enabled(db: &Connection, repository: i64) -> Result<bool> {
    let raw: Option<String> = db
        .query_row("SELECT data FROM merge_repositories WHERE repository_id=?1", [repository], |r| r.get(0))
        .optional()?;
    Ok(raw.map(|r| serde_json::from_str::<Value>(&r)).transpose()?.is_some_and(|v| v["enabled"] == true))
}

/// The newest completed review of a PR link (on any task), and whether a
/// round of it is still running.
fn review(db: &Connection, link: &str) -> Result<(Option<Value>, bool)> {
    let latest: Option<String> = db
        .query_row(
            "SELECT data FROM pr_reviews WHERE link_id=?1 AND status='completed' ORDER BY rowid DESC LIMIT 1",
            [link],
            |r| r.get(0),
        )
        .optional()?;
    let running: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pr_reviews WHERE link_id=?1 AND status IN ('preparing','running'))",
        [link],
        |r| r.get(0),
    )?;
    Ok((latest.map(|r| serde_json::from_str(&r)).transpose()?, running))
}

/// Who may release (design §2): the user, or the task's active dispatcher
/// when it is a lead of the task's Project. The task's executor never may.
fn releaser(store: &Store, db: &Connection, actor: Option<&str>, task: &collab::SharedTask) -> Result<(TaskActor, Value)> {
    let (author, source) = collab::actor_context(store, db, actor)?;
    ensure!(
        task.archived_at.is_none() && !matches!(task.status.as_str(), "done" | "cancelled"),
        "merge_release_not_allowed: the task is {}; reopen it first",
        if task.archived_at.is_some() { "archived" } else { task.status.as_str() }
    );
    let Some(agent) = actor else {
        return Ok((author, source));
    };
    ensure!(
        task.assignee_agent_id.as_deref() != Some(agent),
        "merge_release_not_allowed: the task's executor cannot release its own PR; its dispatching lead or the user does"
    );
    let dispatch = task
        .dispatch
        .as_ref()
        .filter(|d| d.active)
        .context("merge_release_not_allowed: the task has no active dispatch, so only the user can release its merge")?;
    ensure!(
        dispatch.requested_by.kind == "agent" && dispatch.requested_by.id == agent,
        "merge_release_not_allowed: only the task's dispatcher (a lead of its Project) or the user can release its merge"
    );
    let project: Option<String> = db
        .query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&task.id], |r| r.get(0))
        .optional()?;
    let project = project.context("merge_release_not_allowed: the task is in no Project, so only the user can release its merge")?;
    ensure!(
        crate::agent_roles::leads(db, agent, &project)?,
        "merge_release_not_allowed: the dispatcher is not a lead of the task's Project"
    );
    Ok((author, source))
}

/// Everything a release needs before GitHub is read, checked again when it
/// is committed.
pub(super) struct Plan {
    pub task: String,
    pub reference: String,
    pub repository_id: i64,
    pub repository: String,
    pub number: u64,
    pub link: String,
    pub author: TaskActor,
    pub source: Value,
}
fn plan(store: &Store, db: &Connection, actor: Option<&str>, input: &Enqueue) -> Result<Plan> {
    let (task, seq) = collab::task_key(db, &input.task_id)?;
    let shared = collab::load_task(db, &task)?;
    let (author, source) = releaser(store, db, actor, &shared)?;
    let target = crate::github::client::parse(&input.pull_url, true)?;
    let number = match (target.kind.as_deref(), target.number) {
        (Some("pull"), Some(n)) => n,
        _ => bail!("invalid_input: pullUrl must be a pull request URL"),
    };
    let project: Option<String> = db
        .query_row("SELECT project_id FROM project_tasks WHERE task_id=?1", [&task], |r| r.get(0))
        .optional()?;
    let repository: Option<(i64, String)> = db
        .query_row(
            "SELECT r.id,json_extract(r.data,'$.fullName') FROM github_repositories r JOIN github_project_repos p ON p.repo_id=r.id
             WHERE p.project_id=?1 AND lower(json_extract(r.data,'$.fullName'))=lower(?2)",
            params![project, target.repo],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let (repository_id, repository) =
        repository.context("Link this repository in the task's Project settings first")?;
    let link = format!("{repository_id}:pull:{number}");
    let linked: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM github_task_links WHERE task_id=?1 AND object_id=?2)",
        params![task, link],
        |r| r.get(0),
    )?;
    ensure!(linked, "This PR is not linked to the task; link it with github_links first");
    ensure!(
        enabled(db, repository_id)?,
        "merge_queue_disabled: the merge queue is off for {repository}; only the user can turn it on in Settings"
    );
    let (latest, running) = review(db, &link)?;
    match checks::review(&json!({"headSha":input.head_sha}), latest.as_ref(), running) {
        Ok(_) => {}
        Err(Hold::Wait(detail)) => bail!("review_running: {detail}"),
        Err(Hold::Stop(reason, detail)) => bail!("{reason}: {detail}"),
    }
    let busy: Option<(String, String)> = db
        .query_row(
            &format!("SELECT id,state FROM merge_entries WHERE repository_id=?1 AND number=?2 AND state IN {ACTIVE}"),
            params![repository_id, number],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((id, state)) = busy {
        bail!("merge_already_queued: entry {id} for #{number} is {state}");
    }
    Ok(Plan {
        task,
        reference: format!("T-{seq}"),
        repository_id,
        repository,
        number,
        link,
        author,
        source,
    })
}

fn receipt_payload(db: &Connection, operation: &str, input: &Value) -> Result<Value> {
    let mut value = input.clone();
    if let Some(task) = value["taskId"].as_str() {
        value["taskId"] = json!(collab::task_key(db, task)?.0);
    }
    value["operation"] = json!(operation);
    Ok(value)
}
/// The answer of an earlier request with this requestId, or None.
fn previous(db: &Connection, actor: Option<&str>, operation: &str, key: &str, input: &Value) -> Result<Option<Value>> {
    let receipt: Option<(String, String)> = db
        .query_row(
            "SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation=?2 AND request_id=?3",
            params![actor_key(actor), operation, key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    let Some((saved, response)) = receipt else { return Ok(None) };
    ensure!(
        serde_json::from_str::<Value>(&saved)? == receipt_payload(db, operation, input)?,
        "idempotency_conflict: requestId already has another merge queue payload"
    );
    let response: Value = serde_json::from_str(&response)?;
    Ok(Some(entry(db, response["entryId"].as_str().context("Invalid merge receipt")?)?))
}
fn receipt(db: &Connection, actor: Option<&str>, operation: &str, key: &str, input: &Value, id: &str) -> Result<()> {
    db.execute(
        "INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,?2,?3,?4,?5)",
        params![actor_key(actor), operation, key, receipt_payload(db, operation, input)?.to_string(), json!({"entryId":id}).to_string()],
    )?;
    Ok(())
}

/// The comment and mail for an entry that became ready or stopped.
fn announce(db: &Connection, e: &Value, priority: &str) -> Result<()> {
    let head: String = e["headSha"].as_str().unwrap_or("").chars().take(12).collect();
    let n = e["number"].as_u64().unwrap_or(0);
    let id = e["id"].as_str().unwrap_or("");
    let body = match e["state"].as_str() {
        Some("ready") => {
            let ev = &e["evidence"];
            let jobs = ev["gate"]["runs"].as_array().map(|r| r.iter().map(|r| r["jobs"].as_array().map_or(0, Vec::len)).sum::<usize>()).unwrap_or(0);
            format!("Merge queue (dry run): #{n} at {head} is ready to merge. Review {} at this head concluded {}. Main {} with CI since release green. Gate: the PR's merge ref {} is the merge of that main and the head (tree {}); {jobs} CI jobs checked out exactly that merge. Would merge: {} with sha={} as a merge commit. Nothing was written to GitHub. Entry {id}: merge_get(entryId) has the evidence record.",
                ev["review"]["id"].as_str().unwrap_or("?"), ev["review"]["conclusion"].as_str().unwrap_or("?"),
                ev["main"]["before"].as_str().unwrap_or("?"), ev["gate"]["mergeRef"]["sha"].as_str().unwrap_or("?"),
                ev["gate"]["tree"].as_str().unwrap_or("?"), ev["wouldMerge"]["endpoint"].as_str().unwrap_or("?"), e["headSha"].as_str().unwrap_or("?"))
        }
        _ => format!("Merge queue: #{n} at {head} stopped ({}): {}. Nothing was written to GitHub. merge_retry rechecks it from the start on fresh reads; it never reruns CI. Entry {id}.",
            e["reason"].as_str().unwrap_or("?"), e["detail"].as_str().unwrap_or("")),
    };
    let actor = system();
    let source = json!({"mergeEntryId":id});
    collab::activity(db, e["taskId"].as_str().unwrap_or(""), "comment", &actor, &source,
        json!({"mergeEntryId":id,"mergeEvidence":e["evidence"],"body":body}))?;
    let mut recipients: Vec<Value> = Vec::new();
    if e["release"]["by"]["kind"] == "agent" {
        recipients.push(e["release"]["by"].clone());
    }
    let task = collab::load_task(db, e["taskId"].as_str().unwrap_or(""))?;
    if let Some(assignee) = task.assignee.filter(|a| a.kind == "agent") {
        let assignee = serde_json::to_value(assignee)?;
        if !recipients.iter().any(|r| r["id"] == assignee["id"]) {
            recipients.push(assignee);
        }
    }
    for recipient in recipients {
        let message = uuid::Uuid::new_v4().to_string();
        collab::insert_message(db, json!({"id":message,"seq":0,"sender":actor,"recipient":recipient,"body":body,"taskId":e["taskId"],
            "replyTo":null,"threadId":message,"createdAt":now(),"source":source,"priority":priority,
            "metadata":{"kind":"merge","entryId":id,"status":e["state"],"reason":e["reason"],"name":format!("PR #{n}")}}))?;
    }
    Ok(())
}

impl Store {
    pub(super) fn merge_review(&self, link: &str) -> Result<(Option<Value>, bool)> {
        review(&self.db.read()?, link)
    }

    /// The release's checks before anything is read from GitHub, or the
    /// entry an earlier request with this requestId made.
    pub(super) fn merge_release_plan(&self, actor: Option<&str>, input: &Enqueue) -> Result<Result<Plan, Value>> {
        let db = self.db.read()?;
        let value = serde_json::to_value(input)?;
        if let Some(old) = previous(&db, actor, "merge_enqueue", &input.request_id, &value)? {
            return Ok(Err(old));
        }
        Ok(Ok(plan(self, &db, actor, input)?))
    }

    /// Commit a release, checking everything again inside the transaction.
    pub(super) fn merge_enqueue(&self, actor: Option<&str>, input: &Enqueue, pr: &Value, main: &str) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let value = serde_json::to_value(input)?;
        if let Some(old) = previous(&tx, actor, "merge_enqueue", &input.request_id, &value)? {
            return Ok(old);
        }
        let p = plan(self, &tx, actor, input)?;
        ensure!(
            pr["head"]["sha"] == input.head_sha,
            "head_moved: the PR head is {}, not {}",
            pr["head"]["sha"].as_str().unwrap_or("?"),
            input.head_sha
        );
        checks::pull(&json!({"headSha":input.head_sha,"baseBranch":pr["base"]["ref"]}), pr)
            .map_err(|h| anyhow::anyhow!("{}", match h { Hold::Stop(r, d) => format!("{r}: {d}"), Hold::Wait(d) => d }))?;
        let (latest, _) = review(&tx, &p.link)?;
        let id = uuid::Uuid::new_v4().to_string();
        let at = now();
        let e = json!({"id":id,"entryId":id,"taskId":p.task,"taskReference":p.reference,"repositoryId":p.repository_id,
            "repository":p.repository,"number":p.number,"url":format!("https://github.com/{}/pull/{}",p.repository,p.number),
            "linkId":p.link,"headSha":input.head_sha,"baseBranch":pr["base"]["ref"],"mainAtRelease":main,
            "requireWorkflows":input.require_workflows.clone().unwrap_or_default(),"note":input.note,
            "release":{"by":p.author,"requestId":input.request_id,"at":at,"source":p.source,"reviewId":latest.as_ref().map(|r| r["id"].clone())},
            "state":"queued","reason":null,"detail":"Released; Core checks it before anything else happens.","attempt":0,"checks":0,
            "waits":0,"readFailures":0,"waitingSince":null,"nextCheck":0,"evidence":null,"lastEvidence":null,
            "history":[{"at":at,"state":"queued","reason":null,"detail":"released"}],"dryRun":true,"createdAt":at,"updatedAt":at});
        tx.execute(
            "INSERT INTO merge_entries(id,task_id,repository_id,number,state,next_check,data) VALUES(?1,?2,?3,?4,'queued',0,?5)",
            params![id, p.task, p.repository_id, p.number, e.to_string()],
        )?;
        receipt(&tx, actor, "merge_enqueue", &input.request_id, &value, &id)?;
        let head: String = input.head_sha.chars().take(12).collect();
        collab::activity(&tx, &p.task, "comment", &p.author, &p.source, json!({"mergeEntryId":id,
            "body":format!("Merge queue: released #{} at {head} on main {} (entry {id}). The release says the review pair is complete; Core checks the last round at this head, CI and main before anything else. This slice is a dry run: it ends at ready and writes nothing to GitHub.",
                p.number, &main[..12.min(main.len())])}))?;
        tx.commit()?;
        Ok(e)
    }

    pub(super) fn merge_get(&self, input: &Scope) -> Result<Value> {
        let db = self.db.read()?;
        if let Some(id) = &input.entry_id {
            return entry(&db, id);
        }
        let task = collab::task_key(&db, input.task_id.as_deref().context("invalid_input: give entryId or taskId")?)?.0;
        let raw: Option<String> = db
            .query_row("SELECT data FROM merge_entries WHERE task_id=?1 ORDER BY rowid DESC LIMIT 1", [task], |r| r.get(0))
            .optional()?;
        Ok(serde_json::from_str(&raw.context("merge_entry_not_found: This task has no merge entry")?)?)
    }

    pub(super) fn merge_list(&self, input: &Scope) -> Result<Value> {
        let db = self.db.read()?;
        let task = input.task_id.as_deref().map(|t| collab::task_key(&db, t)).transpose()?.map(|t| t.0);
        let mut q = db.prepare(
            "SELECT json_remove(data,'$.history','$.lastEvidence') FROM merge_entries
             WHERE (?1 IS NULL OR repository_id=?1) AND (?2 IS NULL OR state=?2) AND (?3 IS NULL OR task_id=?3)
             ORDER BY rowid DESC LIMIT 50",
        )?;
        let rows = q
            .query_map(params![input.repository_id, input.state, task], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
            .collect::<Result<Vec<_>>>()?;
        Ok(json!({"entries":rows}))
    }

    /// Cancel an entry that still holds its PR, or retry a stopped one.
    pub(super) fn merge_change(&self, actor: Option<&str>, operation: &str, input: &Change) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let value = serde_json::to_value(input)?;
        if let Some(old) = previous(&tx, actor, operation, &input.request_id, &value)? {
            return Ok(old);
        }
        let (author, source) = collab::actor_context(self, &tx, actor)?;
        let mut e = entry(&tx, &input.entry_id)?;
        ensure!(
            actor.is_none() || (e["release"]["by"]["kind"] == "agent" && e["release"]["by"]["id"] == actor.unwrap_or("")),
            "merge_release_not_allowed: only the Agent that released this merge, or the user, can change it"
        );
        let state = e["state"].as_str().unwrap_or("").to_owned();
        let (next, text) = if operation == "merge_cancel" {
            ensure!(matches!(state.as_str(), "queued" | "waiting" | "ready"), "merge_not_active: the entry is {state}");
            ("cancelled", format!("Merge queue: entry {} for #{} cancelled by {}. {}", input.entry_id, e["number"], author.name, input.reason.as_deref().unwrap_or("")))
        } else {
            ensure!(state == "stopped", "merge_not_stopped: only a stopped entry can be retried; it is {state}");
            let busy: bool = tx.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM merge_entries WHERE repository_id=?1 AND number=?2 AND state IN {ACTIVE})"),
                params![e["repositoryId"].as_i64(), e["number"].as_i64()],
                |r| r.get(0),
            )?;
            ensure!(!busy, "merge_already_queued: another entry holds #{}", e["number"]);
            ("queued", format!("Merge queue: entry {} for #{} retried by {}; every check runs again on fresh reads.", input.entry_id, e["number"], author.name))
        };
        e["state"] = json!(next);
        e["reason"] = Value::Null;
        e["detail"] = json!(input.reason.clone().unwrap_or_default());
        e["nextCheck"] = json!(0);
        e["waits"] = json!(0);
        e["readFailures"] = json!(0);
        e["waitingSince"] = Value::Null;
        e["attempt"] = json!(e["attempt"].as_i64().unwrap_or(0) + 1);
        e["updatedAt"] = json!(now());
        history(&mut e, next, &Value::Null, &json!(text));
        save(&tx, &e)?;
        receipt(&tx, actor, operation, &input.request_id, &value, &input.entry_id)?;
        collab::activity(&tx, e["taskId"].as_str().unwrap_or(""), "comment", &author, &source, json!({"mergeEntryId":input.entry_id,"body":text}))?;
        tx.commit()?;
        Ok(e)
    }

    /// Entries whose next check is due, oldest release first.
    pub(super) fn merge_due(&self) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q = db.prepare(
            "SELECT data FROM merge_entries WHERE state IN ('queued','waiting') AND next_check<=?1 ORDER BY rowid LIMIT 8",
        )?;
        let rows = q
            .query_map([epoch()], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
            .collect();
        rows
    }

    /// Record one check of `id` that started at `attempt`. A cancel or retry
    /// in between moved the attempt on, and the outcome is then dropped.
    pub(super) fn merge_record(
        &self,
        id: &str,
        attempt: i64,
        outcome: std::result::Result<(Value, checks::Check<()>), String>,
        cooldown: i64,
    ) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["attempt"].as_i64() != Some(attempt) || !matches!(e["state"].as_str(), Some("queued" | "waiting")) {
            return Ok(false);
        }
        let now_epoch = epoch();
        e["checks"] = json!(e["checks"].as_i64().unwrap_or(0) + 1);
        e["updatedAt"] = json!(now());
        let wait = |e: &mut Value, detail: String, at_least: i64| {
            let waits = e["waits"].as_i64().unwrap_or(0);
            let since = e["waitingSince"].as_i64().unwrap_or(now_epoch);
            e["waits"] = json!(waits + 1);
            e["waitingSince"] = json!(since);
            e["nextCheck"] = json!((now_epoch + (60i64 << waits.min(3)).min(600)).max(at_least));
            if now_epoch - since > WAIT_LIMIT {
                e["state"] = json!("stopped");
                e["reason"] = json!("wait_timeout");
                e["detail"] = json!(format!("Still waiting after six hours: {detail}"));
            } else {
                e["state"] = json!("waiting");
                e["reason"] = json!("waiting");
                e["detail"] = json!(detail);
            }
        };
        match outcome {
            Ok((evidence, decision)) => {
                e["readFailures"] = json!(0);
                e["lastEvidence"] = evidence.clone();
                match decision {
                    Ok(()) => {
                        e["state"] = json!("ready");
                        e["reason"] = Value::Null;
                        e["detail"] = json!("Every gate check passed; the merge would run now.");
                        e["nextCheck"] = json!(0);
                    }
                    Err(Hold::Wait(detail)) => wait(&mut e, detail, 0),
                    Err(Hold::Stop(reason, detail)) => {
                        e["state"] = json!("stopped");
                        e["reason"] = json!(reason);
                        e["detail"] = json!(detail);
                    }
                }
            }
            Err(error) if error.starts_with("rate_limited") => wait(&mut e, error, cooldown + 5),
            Err(error) => {
                let failures = e["readFailures"].as_i64().unwrap_or(0) + 1;
                e["readFailures"] = json!(failures);
                if failures >= READ_FAILURES {
                    e["state"] = json!("stopped");
                    e["reason"] = json!("github_unreachable");
                    e["detail"] = json!(format!("{failures} reads in a row failed; the last: {error}"));
                } else {
                    wait(&mut e, format!("A GitHub read failed ({error}); checking again"), 0);
                }
            }
        }
        let state = e["state"].as_str().unwrap_or("").to_owned();
        if matches!(state.as_str(), "ready" | "stopped") {
            let last = e["lastEvidence"].clone();
            e["evidence"] = json!({"entry":e["id"],"repository":e["repository"],"pr":e["number"],"head":e["headSha"],
                "release":e["release"],"review":last["review"],"main":last["main"],"gate":last["gate"],
                "wouldMerge":last["wouldMerge"],"checkedAt":last["checkedAt"],"dryRun":true,
                "stop":if state == "stopped" { json!({"reason":e["reason"],"detail":e["detail"]}) } else { Value::Null }});
        }
        let (reason, detail) = (e["reason"].clone(), e["detail"].clone());
        history(&mut e, &state, &reason, &detail);
        save(&tx, &e)?;
        if matches!(state.as_str(), "ready" | "stopped") {
            announce(&tx, &e, if e["reason"] == "main_red" { "urgent" } else { "normal" })?;
        }
        tx.commit()?;
        Ok(matches!(state.as_str(), "ready" | "stopped"))
    }

    /// The user's switch for one linked repository.
    pub(super) fn merge_set_enabled(&self, repository: i64, on: bool) -> Result<Value> {
        let db = self.db.write()?;
        let known: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM github_repositories WHERE id=?1)", [repository], |r| r.get(0))?;
        ensure!(known, "not_found: link the repository to a Project first");
        let data = json!({"repositoryId":repository,"enabled":on,"updatedAt":now()});
        db.execute(
            "INSERT INTO merge_repositories(repository_id,data) VALUES(?1,?2) ON CONFLICT(repository_id) DO UPDATE SET data=excluded.data",
            params![repository, data.to_string()],
        )?;
        Ok(data)
    }
    pub(super) fn merge_repository(&self, repository: i64) -> Result<Value> {
        let db = self.db.read()?;
        Ok(json!({"repositoryId":repository,"enabled":enabled(&db, repository)?}))
    }
}
