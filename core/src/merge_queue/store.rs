//! Merge entries: what was released, who released it, and every check's
//! outcome. All GitHub I/O happens outside these transactions.
use super::checks::{self, Hold};
use super::remote::{Followed, MergeOutcome};
use super::{Change, Enqueue, Scope};
use crate::collaboration_store::{self as collab, TaskActor};
use crate::{model::now, store::Store};
use anyhow::{Context, Result, bail, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

/// Entries that still hold their PR: a second release of it is refused.
const ACTIVE: &str = "('queued','waiting','ready','merging')";
/// A check that has waited this long stops instead (seconds).
const WAIT_LIMIT: i64 = 6 * 3600;
/// Consecutive failed reads before an entry stops.
const READ_FAILURES: i64 = 8;
/// Consecutive merge requests that could not be sent before an entry stops.
const NOT_SENT_LIMIT: i64 = 5;
/// What a switch and a release mean: 2 since Core merges. The dry-run build
/// (1, no `queueVersion`) wrote the same tables, but there a switch that was
/// on only let Core check, and `ready` was final.
const QUEUE_VERSION: i64 = 2;

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS merge_entries(
        id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES collaboration_tasks(id),
        repository_id INTEGER NOT NULL,number INTEGER NOT NULL,state TEXT NOT NULL,
        next_check INTEGER NOT NULL DEFAULT 0,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS merge_entries_task ON merge_entries(task_id);
        CREATE INDEX IF NOT EXISTS merge_entries_due ON merge_entries(state,next_check);
        DROP INDEX IF EXISTS merge_entries_active;
        CREATE UNIQUE INDEX IF NOT EXISTS merge_entries_holding ON merge_entries(repository_id,number)
        WHERE state IN ('queued','waiting','ready','merging');
        CREATE TABLE IF NOT EXISTS merge_repositories(repository_id INTEGER PRIMARY KEY,data TEXT NOT NULL);",
    )?;
    renew_consent(db)
}

/// Consent given to the dry-run build does not carry over to real merges.
/// Every switch from before is turned off once, saying so in its journal, and
/// every entry from before that still holds its PR stops. Runs on every open;
/// the second time it finds nothing.
fn renew_consent(db: &Connection) -> Result<()> {
    let older = format!("COALESCE(json_extract(data,'$.queueVersion'),1)<{QUEUE_VERSION}");
    let switches: Vec<(i64, String)> = db
        .prepare(&format!("SELECT repository_id,data FROM merge_repositories WHERE {older}"))?
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    for (id, raw) in switches {
        let mut data: Value = serde_json::from_str(&raw)?;
        if data["enabled"] == true {
            data["enabled"] = json!(false);
            switched(&mut data, false, "Yuzuno Core", "Turned off at the upgrade: in the dry-run build this switch only let Core check; now it lets Core merge. Turn it on again for real merges.");
        }
        save_repository(db, id, &data)?;
    }
    let held: Vec<String> = db
        .prepare(&format!("SELECT data FROM merge_entries WHERE state IN ('queued','waiting','ready') AND {older}"))?
        .query_map([], |r| r.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    for raw in held {
        let mut e: Value = serde_json::from_str(&raw)?;
        stop(&mut e, "dry_run_ended", "Released before Core merged for real; that release does not let Core merge. Release the PR again to merge it.".into());
        e["updatedAt"] = json!(now());
        let detail = e["detail"].clone();
        history(&mut e, "stopped", &json!("dry_run_ended"), &detail);
        save(db, &e)?;
    }
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

/// A repository's queue state: the user's switch (design §2) and its pause.
fn repository(db: &Connection, id: i64) -> Result<Value> {
    let raw: Option<String> = db
        .query_row("SELECT data FROM merge_repositories WHERE repository_id=?1", [id], |r| r.get(0))
        .optional()?;
    let mut v = raw.map(|r| serde_json::from_str::<Value>(&r)).transpose()?.unwrap_or_else(|| json!({}));
    v["repositoryId"] = json!(id);
    if !v["enabled"].is_boolean() {
        v["enabled"] = json!(false);
    }
    if v.get("paused").is_none() {
        v["paused"] = Value::Null;
    }
    Ok(v)
}
fn save_repository(db: &Connection, id: i64, data: &Value) -> Result<()> {
    let mut data = data.clone();
    data["queueVersion"] = json!(QUEUE_VERSION);
    db.execute(
        "INSERT INTO merge_repositories(repository_id,data) VALUES(?1,?2) ON CONFLICT(repository_id) DO UPDATE SET data=excluded.data",
        params![id, data.to_string()],
    )?;
    Ok(())
}
fn enabled(db: &Connection, repository_id: i64) -> Result<bool> {
    Ok(repository(db, repository_id)?["enabled"] == true)
}
/// One line of a repository's switch journal; the newest 50 are kept.
fn switched(data: &mut Value, on: bool, by: &str, detail: &str) {
    let mut list = data["switches"].as_array().cloned().unwrap_or_default();
    list.push(json!({"at":now(),"enabled":on,"by":by,"detail":detail}));
    let excess = list.len().saturating_sub(50);
    list.drain(..excess);
    data["switches"] = json!(list);
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
    let (task, _) = collab::task_key(db, &input.task_id)?;
    let reference = collab::task_number(db, &task)?;
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
        "merge_queue_disabled: the merge queue is off for {repository}; only the user can turn it on, through PUT /api/merge-queue/repositories/{{id}} on this Core (a Settings switch comes in T-37 S2b)"
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
            params![repository_id, number as i64],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    if let Some((id, state)) = busy {
        bail!("merge_already_queued: entry {id} for #{number} is {state}");
    }
    Ok(Plan {
        task,
        reference,
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

fn short(sha: &Value) -> String {
    sha.as_str().unwrap_or("?").chars().take(12).collect()
}

/// The evidence record of an entry as it stands: what was released, what the
/// last check read, the batch, the merge and its follow-up, and any stop.
fn record(e: &Value) -> Value {
    let last = &e["lastEvidence"];
    json!({"entry":e["id"],"repository":e["repository"],"pr":e["number"],"head":e["headSha"],"state":e["state"],
        "release":e["release"],"review":last["review"],"main":last["main"],"gate":last["gate"],"checkedAt":last["checkedAt"],
        "batch":e["batch"],"merge":e["merge"],
        "stop":if e["state"] == "stopped" { json!({"reason":e["reason"],"detail":e["detail"]}) } else { Value::Null }})
}

/// System mail to each of `recipients`.
fn mail(db: &Connection, recipients: &[Value], body: &str, task: &Value, priority: &str, metadata: Value) -> Result<()> {
    let actor = system();
    for recipient in recipients {
        let message = uuid::Uuid::new_v4().to_string();
        collab::insert_message(db, json!({"id":message,"seq":0,"sender":actor,"recipient":recipient,"body":body,"taskId":task,
            "replyTo":null,"threadId":message,"createdAt":now(),"source":{"mergeQueue":true},"priority":priority,"metadata":metadata}))?;
    }
    Ok(())
}

/// The comment and mail for an entry that merged, ended or stopped: on its
/// task, to the Agent that released it and to the task's executor.
fn announce(db: &Connection, e: &Value, priority: &str) -> Result<()> {
    let head: String = e["headSha"].as_str().unwrap_or("").chars().take(12).collect();
    let n = e["number"].as_u64().unwrap_or(0);
    let id = e["id"].as_str().unwrap_or("");
    let m = &e["merge"];
    let gate = &e["lastEvidence"]["gate"];
    let body = match (e["state"].as_str(), e["reason"].as_str()) {
        (Some("merged"), _) => format!(
            "Merge queue: merged #{n} at {head} as {}, a merge commit pinned to that head. Gate: {} (tree {}), with every CI job on exactly that merge. Post-check: parents main {} and the head, tree as tested. Core now follows main's push CI on it. Entry {id}: merge_get(entryId) has the evidence record.",
            short(&m["sha"]), gate["kind"].as_str().unwrap_or("?"), short(&gate["tree"]), short(&m["expectedMain"])),
        (Some("done"), _) => format!(
            "Merge queue: main's push CI on {} (#{n}) concluded {}.{} Entry {id}.",
            short(&m["sha"]), m["mainCi"]["conclusion"].as_str().unwrap_or("?"),
            if e["reason"] == "main_red" { " The repository's queue is paused until a lead or the user unpauses it, or CI on a newer main is green." } else { "" }),
        (_, Some("post_check_failed")) => format!(
            "Merge queue: #{n} at {head} was merged as {}, but the post-check failed: {}. The repository's queue is paused; a person has to look. Entry {id}.",
            short(&m["sha"]), e["detail"].as_str().unwrap_or("")),
        _ => format!(
            "Merge queue: #{n} at {head} stopped ({}): {}. Core merged nothing{}. merge_retry checks it again from the start on fresh reads; Core never reruns CI. Entry {id}.",
            e["reason"].as_str().unwrap_or("?"), e["detail"].as_str().unwrap_or(""),
            if e["batch"].is_object() { " and removes its own batch branch and PR" } else { "" }),
    };
    let source = json!({"mergeEntryId":id});
    collab::activity(db, e["taskId"].as_str().unwrap_or(""), "comment", &system(), &source,
        json!({"mergeEntryId":id,"mergeEvidence":record(e),"body":body}))?;
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
    mail(db, &recipients, &body, &e["taskId"], priority,
        json!({"kind":"merge","entryId":id,"status":e["state"],"reason":e["reason"],"name":format!("PR #{n}")}))
}

/// Who is told of a pause or its end: the releasers of `entries` and the
/// leads of every Project the repository is linked to.
fn pause_recipients(store: &Store, db: &Connection, repository_id: i64, entries: &[Value]) -> Result<Vec<Value>> {
    let mut ids: Vec<String> = entries
        .iter()
        .filter(|e| e["release"]["by"]["kind"] == "agent")
        .filter_map(|e| e["release"]["by"]["id"].as_str().map(String::from))
        .collect();
    let mut q = db.prepare(
        "SELECT DISTINCT r.agent_id FROM agent_roles r JOIN project_agents p ON p.agent_id=r.agent_id AND p.project_id=r.project_id
         JOIN github_project_repos g ON g.project_id=r.project_id WHERE r.kind='lead' AND g.repo_id=?1",
    )?;
    for id in q.query_map([repository_id], |r| r.get::<_, String>(0))? {
        ids.push(id?);
    }
    ids.sort();
    ids.dedup();
    ids.iter()
        .filter_map(|id| collab::agent_actor(store, db, id).ok())
        .map(|a| Ok(serde_json::to_value(a)?))
        .collect()
}

/// Pause the repository's queue because of `e` (design §5): no entry merges
/// until a lead or the user unpauses it, or, for main_red, CI on a newer main
/// is green. A repository already paused keeps its first pause.
/// Pause the repository's queue. `run` is the red main CI run behind a
/// main_red pause, so an unpause at that same main can accept it.
fn pause(store: &Store, db: &Connection, e: &Value, reason: &str, main: &str, run: &Value, detail: &str) -> Result<()> {
    let repository_id = e["repositoryId"].as_i64().unwrap_or(0);
    let mut r = repository(db, repository_id)?;
    if !r["paused"].is_null() {
        return Ok(());
    }
    r["paused"] = json!({"reason":reason,"at":now(),"entryId":e["id"],"number":e["number"],"main":main,"run":run,"base":e["baseBranch"],"detail":detail});
    save_repository(db, repository_id, &r)?;
    let body = format!(
        "Merge queue: {} is paused ({reason}) by entry {} for #{}: {detail}. No entry merges until a lead or the user unpauses it (merge_unpause){}.",
        e["repository"].as_str().unwrap_or("?"), e["id"].as_str().unwrap_or("?"), e["number"],
        if reason == "main_red" { ", or CI on a newer main is green" } else { "" }
    );
    collab::activity(db, e["taskId"].as_str().unwrap_or(""), "comment", &system(), &json!({"mergeEntryId":e["id"]}),
        json!({"mergeEntryId":e["id"],"mergePause":r["paused"],"body":body}))?;
    let recipients = pause_recipients(store, db, repository_id, std::slice::from_ref(e))?;
    mail(db, &recipients, &body, &e["taskId"], "urgent", json!({"kind":"merge","status":"paused","reason":reason,"name":e["repository"]}))
}

/// End the repository's pause: journal what ended it, and re-anchor every
/// waiting entry on the paused base branch at `main` (that branch's head), so
/// main CI counts for them from there on.
/// `skip` is an entry the caller re-anchors itself. An unpause while main is
/// still the red commit of a main_red pause accepts that red run; the journal
/// keeps it, and every entry anchored at that main no longer counts it (by its
/// id, see `checks::accepted_runs`). Answers the waiting entries and the
/// accepted run, if any.
fn clear(store: &Store, db: &Connection, repository_id: i64, by: Value, main: &str, skip: Option<&str>) -> Result<(Vec<Value>, Value)> {
    let mut r = repository(db, repository_id)?;
    let paused = std::mem::take(&mut r["paused"]);
    ensure!(!paused.is_null(), "merge_not_paused: the merge queue of this repository is not paused");
    let accepted = if paused["reason"] == "main_red" && paused["main"] == main && !paused["run"].is_null() {
        json!({"id":paused["run"],"headSha":main})
    } else {
        Value::Null
    };
    let mut ended = paused.clone();
    ended["clearedAt"] = json!(now());
    ended["clearedBy"] = by.clone();
    ended["reanchoredAt"] = json!(main);
    ended["acceptedRun"] = accepted.clone();
    let mut pauses = r["pauses"].as_array().cloned().unwrap_or_default();
    pauses.push(ended);
    let excess = pauses.len().saturating_sub(20);
    pauses.drain(..excess);
    r["pauses"] = json!(pauses);
    save_repository(db, repository_id, &r)?;
    let mut q = db.prepare("SELECT data FROM merge_entries WHERE repository_id=?1 AND state IN ('queued','waiting','ready') ORDER BY rowid")?;
    let waiting = q
        .query_map([repository_id], |row| row.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        // `main` is the paused branch's head: an entry on another base is not
        // anchored there.
        .filter(|e| !paused["base"].is_string() || e["baseBranch"] == paused["base"])
        .collect::<Vec<_>>();
    let text = if accepted.is_null() {
        format!(
            "Merge queue: {} unpaused ({} cleared by {}). Waiting entries count main CI from main {} on.",
            r["repositoryId"], paused["reason"].as_str().unwrap_or("pause"), by["by"].as_str().unwrap_or("?"), &main[..12.min(main.len())]
        )
    } else {
        format!(
            "Merge queue: {} unpaused (main_red cleared by {}). Main is still {}; its red run {} is accepted by this unpause. Waiting entries count main CI from now on, and each still needs green CI on this main before it merges.",
            r["repositoryId"], by["by"].as_str().unwrap_or("?"), &main[..12.min(main.len())], accepted["id"]
        )
    };
    for mut e in waiting.iter().cloned() {
        if Some(e["id"].as_str().unwrap_or("")) != skip {
            reanchor(&mut e, main, &text);
            save(db, &e)?;
        }
        collab::activity(db, e["taskId"].as_str().unwrap_or(""), "comment", &system(), &json!({"mergeEntryId":e["id"]}),
            json!({"mergeEntryId":e["id"],"body":text}))?;
    }
    let recipients = pause_recipients(store, db, repository_id, &waiting)?;
    let task = waiting.first().map(|e| e["taskId"].clone()).unwrap_or(Value::Null);
    mail(db, &recipients, &text, &task, "urgent", json!({"kind":"merge","status":"unpaused","name":format!("repository {repository_id}")}))?;
    Ok((waiting, accepted))
}
/// What journaling a merge request came to.
pub(super) enum Journal {
    /// Journaled: the request may go.
    Journaled,
    /// The entry is no longer merging.
    NotMerging,
    /// The repository's queue is paused: nothing journaled, nothing sent.
    Paused(String),
}

/// The main an entry counts main CI from, and since when. A check records its
/// outcome only if the entry still has the anchor the check read.
pub(super) fn anchor(e: &Value) -> Value {
    json!([e["mainAtRelease"], e["mainAnchoredAt"]])
}
fn reanchor(e: &mut Value, main: &str, why: &str) {
    e["mainAtRelease"] = json!(main);
    e["mainAnchoredAt"] = json!(now());
    e["nextCheck"] = json!(0);
    let (state, reason) = (e["state"].as_str().unwrap_or("").to_owned(), e["reason"].clone());
    history(e, &state, &reason, &json!(why));
}

/// A stopped or cancelled entry still owns its batch: Core removes it next.
fn stop(e: &mut Value, reason: &str, detail: String) {
    e["state"] = json!("stopped");
    e["reason"] = json!(reason);
    e["detail"] = json!(detail);
    release_batch(e);
}
fn release_batch(e: &mut Value) {
    let b = &mut e["batch"];
    if b.is_object() && (b["ref"] == true || b["ref"] == "pending" || b["pr"].is_u64()) && b["cleanup"] != "done" {
        b["cleanup"] = json!("pending");
        e["nextCheck"] = json!(0);
    }
}

/// What a check, merge or follow-up of an entry may do next.
pub(super) struct Recorded {
    pub announced: bool,
    pub merge: Option<Value>,
}

impl Store {
    pub(super) fn merge_review(&self, link: &str) -> Result<(Option<Value>, bool)> {
        let db = self.db.read()?;
        review(&db, link)
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
            "linkId":p.link,"headSha":input.head_sha,"baseBranch":pr["base"]["ref"],"mainAtRelease":main,"mainAnchoredAt":at,
            "requireWorkflows":input.require_workflows.clone().unwrap_or_default(),"note":input.note,
            "release":{"by":p.author,"requestId":input.request_id,"at":at,"source":p.source,"reviewId":latest.as_ref().map(|r| r["id"].clone())},
            "state":"queued","reason":null,"detail":"Released; Core checks it before anything else happens.","attempt":0,"checks":0,
            "waits":0,"readFailures":0,"waitingSince":null,"nextCheck":0,"evidence":null,"lastEvidence":null,"batch":null,"merge":null,
            "history":[{"at":at,"state":"queued","reason":null,"detail":"released"}],"queueVersion":QUEUE_VERSION,"createdAt":at,"updatedAt":at});
        tx.execute(
            "INSERT INTO merge_entries(id,task_id,repository_id,number,state,next_check,data) VALUES(?1,?2,?3,?4,'queued',0,?5)",
            params![id, p.task, p.repository_id, p.number as i64, e.to_string()],
        )?;
        receipt(&tx, actor, "merge_enqueue", &input.request_id, &value, &id)?;
        let head: String = input.head_sha.chars().take(12).collect();
        collab::activity(&tx, &p.task, "comment", &p.author, &p.source, json!({"mergeEntryId":id,
            "body":format!("Merge queue: released #{} at {head} on main {} (entry {id}). The release says the review pair is complete. Core checks the last round at this head, CI and main, and merges the PR as a merge commit pinned to this head once every check holds, while the queue is on for {}.",
                p.number, &main[..12.min(main.len())], p.repository)}))?;
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

    /// Whether `actor` may cancel or retry entry `id`: the Agent that released
    /// it, or the user. Checked before a retry reads anything from GitHub.
    pub(super) fn merge_change_allowed(&self, actor: Option<&str>, id: &str) -> Result<Value> {
        let db = self.db.read()?;
        let e = entry(&db, id)?;
        may_change(actor, &e)?;
        released_for_merge(&e)?;
        Ok(e)
    }

    /// Cancel an entry that still holds its PR, or retry a stopped one.
    pub(super) fn merge_change(&self, actor: Option<&str>, operation: &str, input: &Change, main: Option<&str>) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let value = serde_json::to_value(input)?;
        if let Some(old) = previous(&tx, actor, operation, &input.request_id, &value)? {
            return Ok(old);
        }
        let (author, source) = collab::actor_context(self, &tx, actor)?;
        let mut e = entry(&tx, &input.entry_id)?;
        may_change(actor, &e)?;
        let state = e["state"].as_str().unwrap_or("").to_owned();
        let (next, text) = if operation == "merge_cancel" {
            ensure!(matches!(state.as_str(), "queued" | "waiting" | "ready"), "merge_not_active: the entry is {state}");
            ("cancelled", format!("Merge queue: entry {} for #{} cancelled by {}. {}", input.entry_id, e["number"], author.name, input.reason.as_deref().unwrap_or("")))
        } else {
            ensure!(state == "stopped", "merge_not_stopped: only a stopped entry can be retried; it is {state}");
            released_for_merge(&e)?;
            ensure!(e["batch"]["cleanup"] != "pending", "merge_cleanup_pending: Core is still removing this entry's batch; retry shortly");
            let busy: bool = tx.query_row(
                &format!("SELECT EXISTS(SELECT 1 FROM merge_entries WHERE repository_id=?1 AND number=?2 AND state IN {ACTIVE})"),
                params![e["repositoryId"].as_i64(), e["number"].as_i64()],
                |r| r.get(0),
            )?;
            ensure!(!busy, "merge_already_queued: another entry holds #{}", e["number"]);
            let main = main.context("A retry needs the current main")?;
            e["mainAtRelease"] = json!(main);
            e["mainAnchoredAt"] = json!(now());
            if e["batch"].is_object() {
                let old = e["batch"].take();
                e["retiredBatches"] = json!([e["retiredBatches"].as_array().cloned().unwrap_or_default(), vec![old]].concat());
            }
            e["merge"] = Value::Null;
            ("queued", format!("Merge queue: entry {} for #{} retried by {}; every check runs again on fresh reads, and main CI counts from main {} on.",
                input.entry_id, e["number"], author.name, &main[..12.min(main.len())]))
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
        if next == "cancelled" {
            release_batch(&mut e);
        }
        history(&mut e, next, &Value::Null, &json!(text));
        save(&tx, &e)?;
        receipt(&tx, actor, operation, &input.request_id, &value, &input.entry_id)?;
        collab::activity(&tx, e["taskId"].as_str().unwrap_or(""), "comment", &author, &source, json!({"mergeEntryId":input.entry_id,"body":text}))?;
        tx.commit()?;
        Ok(e)
    }

    /// One entry as stored now.
    pub(super) fn merge_entry(&self, id: &str) -> Result<Value> {
        let db = self.db.read()?;
        entry(&db, id)
    }

    /// The stored answer of an earlier `merge_unpause` with this requestId, so
    /// a retry after a lost answer gets it back before any precondition or
    /// GitHub read. Another payload under the same requestId is refused.
    pub(super) fn merge_unpause_receipt(&self, actor: Option<&str>, id: i64, request_id: &str, reason: Option<&str>) -> Result<Option<Value>> {
        let db = self.db.read()?;
        let receipt: Option<(String, String)> = db
            .query_row(
                "SELECT input_json,response_json FROM collaboration_requests WHERE actor=?1 AND operation='merge_unpause' AND request_id=?2",
                params![actor_key(actor), request_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let Some((saved, answer)) = receipt else { return Ok(None) };
        ensure!(
            serde_json::from_str::<Value>(&saved)? == json!({"requestId":request_id,"repositoryId":id,"reason":reason}),
            "idempotency_conflict: requestId already has another merge queue payload"
        );
        Ok(Some(serde_json::from_str(&answer)?))
    }

    /// Entries with something due, oldest release first: a check, a merge to
    /// reconcile, a merge to follow, or a batch of Core's own to remove.
    pub(super) fn merge_due(&self) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q = db.prepare(
            "SELECT data FROM merge_entries WHERE next_check<=?1
             AND (state IN ('queued','waiting','ready','merging','merged') OR json_extract(data,'$.batch.cleanup')='pending')
             ORDER BY rowid LIMIT 8",
        )?;
        let rows = q
            .query_map([epoch()], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
            .collect();
        rows
    }

    /// Record one check of `id` that started at `attempt` from `anchor`. A
    /// cancel or retry in between moved the attempt on, and an unpause or
    /// another entry's check that ended a pause moved the anchor on; the
    /// outcome is then dropped, and the entry is checked again. When every gate
    /// check held, the entry merges now if the queue is on, not paused, and no
    /// other merge of its repository is in flight: it becomes `merging`,
    /// journaled before any request is sent, and is returned.
    pub(super) fn merge_record(
        &self,
        id: &str,
        attempt: i64,
        checked_from: &Value,
        outcome: std::result::Result<(Value, checks::Check<()>), String>,
        cooldown: i64,
    ) -> Result<Recorded> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["attempt"].as_i64() != Some(attempt)
            || !matches!(e["state"].as_str(), Some("queued" | "waiting" | "ready"))
            || anchor(&e) != *checked_from
        {
            return Ok(Recorded { announced: false, merge: None });
        }
        let now_epoch = epoch();
        e["checks"] = json!(e["checks"].as_i64().unwrap_or(0) + 1);
        e["updatedAt"] = json!(now());
        let mut merge_now = None;
        match outcome {
            Ok((evidence, decision)) => {
                e["readFailures"] = json!(0);
                e["lastEvidence"] = evidence.clone();
                let repository_id = e["repositoryId"].as_i64().unwrap_or(0);
                let still_paused = !repository(&tx, repository_id)?["paused"].is_null();
                if let Some(by) = evidence["pauseCleared"].as_object().filter(|_| still_paused).map(|b| Value::Object(b.clone())) {
                    let main = by["main"].as_str().unwrap_or("").to_owned();
                    clear(self, &tx, e["repositoryId"].as_i64().unwrap_or(0), by, &main, Some(id))?;
                    reanchor(&mut e, &main, "Re-anchored: CI on a newer main is green, which cleared the pause");
                }
                match decision {
                    Ok(()) => {
                        let repository_id = e["repositoryId"].as_i64().unwrap_or(0);
                        let r = repository(&tx, repository_id)?;
                        // A merge is in flight until its post-check has run: the
                        // next one never lands on an unchecked merge commit.
                        let busy: Option<(i64, String)> = tx
                            .query_row(
                                "SELECT number,state FROM merge_entries WHERE repository_id=?1 AND id<>?2
                                 AND (state='merging' OR (state='merged' AND json_extract(data,'$.merge.post') IS NULL)) LIMIT 1",
                                params![repository_id, id],
                                |row| Ok((row.get(0)?, row.get(1)?)),
                            )
                            .optional()?;
                        let (state, detail, next) = if r["enabled"] != true {
                            ("ready", format!("Every check held, but the merge queue is off for {}; Core writes nothing to GitHub until the user turns it on.", e["repository"].as_str().unwrap_or("?")), now_epoch + 300)
                        } else if !r["paused"].is_null() {
                            ("waiting", format!("Every check held, but the repository's queue is paused ({}).", r["paused"]["reason"].as_str().unwrap_or("?")), now_epoch + 60)
                        } else if let Some((other, other_state)) = busy {
                            let what = if other_state == "merging" { "whose merge is in flight" } else { "whose post-check has not run yet" };
                            ("ready", format!("Every check held; it merges after #{other}, {what}, and a fresh check."), now_epoch + 60)
                        } else {
                            ("merging", "Every check held; Core sends the merge now.".to_owned(), now_epoch + 120)
                        };
                        e["state"] = json!(state);
                        e["reason"] = Value::Null;
                        e["detail"] = json!(detail);
                        e["nextCheck"] = json!(next);
                        e["waits"] = json!(0);
                        e["waitingSince"] = Value::Null;
                        if state == "merging" {
                            e["merge"] = json!({"expectedMain":evidence["main"]["before"],"tree":evidence["gate"]["tree"],"gate":evidence["gate"]["kind"],
                                "head":e["headSha"],"attempts":0,"puts":[],"startedAt":now(),"sha":null,"post":null,"mainCi":null});
                        }
                    }
                    Err(Hold::Wait(detail)) => {
                        // While the repository's queue is paused, an entry waits
                        // for the unpause: that time is not part of the wait limit.
                        if !repository(&tx, e["repositoryId"].as_i64().unwrap_or(0))?["paused"].is_null() {
                            e["waitingSince"] = Value::Null;
                        }
                        wait(&mut e, detail, 0, now_epoch)
                    }
                    Err(Hold::Stop(reason, detail)) => {
                        if reason == "main_red" {
                            let red = evidence["mainRed"]["headSha"].as_str().unwrap_or("").to_owned();
                            pause(self, &tx, &e, "main_red", &red, &evidence["mainRed"]["id"], &detail)?;
                        }
                        stop(&mut e, reason, detail);
                    }
                }
            }
            Err(error) if error.starts_with("rate_limited") => wait(&mut e, error, cooldown + 5, now_epoch),
            Err(error) if error.starts_with("merge_moved_on") => return Ok(Recorded { announced: false, merge: None }),
            Err(error) if error.starts_with("merge_queue_disabled") => wait(&mut e, error, now_epoch + 300, now_epoch),
            Err(error) if error.starts_with("gh_too_old") => stop(&mut e, "gh_too_old", error),
            Err(error) => failed_read(&mut e, error, now_epoch),
        }
        let state = e["state"].as_str().unwrap_or("").to_owned();
        e["evidence"] = record(&e);
        let (reason, detail) = (e["reason"].clone(), e["detail"].clone());
        history(&mut e, &state, &reason, &detail);
        save(&tx, &e)?;
        let announced = state == "stopped";
        if announced {
            announce(&tx, &e, if e["reason"] == "main_red" { "urgent" } else { "normal" })?;
        }
        if state == "merging" {
            merge_now = Some(e.clone());
        }
        tx.commit()?;
        Ok(Recorded { announced, merge: merge_now })
    }

    /// Journal the merge request of `id` before it is sent, so a restart
    /// never sends a second one. Nothing is journaled when the entry is no
    /// longer merging, or when the repository's queue is paused: a merge that
    /// waited (a rate limit, a request that never left Core) while another
    /// entry paused the queue is not sent onto it.
    pub(super) fn merge_put_journal(&self, id: &str, attempt: i64) -> Result<Journal> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["attempt"].as_i64() != Some(attempt) || e["state"] != "merging" {
            return Ok(Journal::NotMerging);
        }
        let paused = repository(&tx, e["repositoryId"].as_i64().unwrap_or(0))?["paused"].clone();
        if !paused.is_null() {
            return Ok(Journal::Paused(format!(
                "The repository's merge queue is paused ({}) since {}, so the merge request was not sent; the entry waits for the unpause.",
                paused["reason"].as_str().unwrap_or("paused"),
                paused["at"].as_str().unwrap_or("?")
            )));
        }
        e["merge"]["attempts"] = json!(1);
        if let Some(puts) = e["merge"]["puts"].as_array_mut() {
            puts.push(json!({"n":puts.len() + 1,"at":now()}));
        }
        e["nextCheck"] = json!(epoch() + 120);
        save(&tx, &e)?;
        tx.commit()?;
        Ok(Journal::Journaled)
    }

    /// The merge request's outcome. Returns the entry when it merged: its
    /// follow-up (post-check, cleanup, main CI) runs next.
    pub(super) fn merge_answered(&self, id: &str, attempt: i64, outcome: std::result::Result<MergeOutcome, String>, cooldown: i64) -> Result<Option<Value>> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["attempt"].as_i64() != Some(attempt) || e["state"] != "merging" {
            return Ok(None);
        }
        let now_epoch = epoch();
        e["updatedAt"] = json!(now());
        let mut urgent = false;
        match outcome {
            Ok(MergeOutcome::Merged(sha)) => {
                e["state"] = json!("merged");
                e["reason"] = Value::Null;
                e["detail"] = json!(format!("Merged as {sha}; Core checks the merge commit and follows main's push CI."));
                e["merge"]["sha"] = json!(sha);
                e["merge"]["mergedAt"] = json!(now());
                e["readFailures"] = json!(0);
                e["waits"] = json!(0);
                e["waitingSince"] = Value::Null;
                e["nextCheck"] = json!(0);
            }
            Ok(MergeOutcome::Refused(detail)) => stop(&mut e, "merge_refused", detail),
            Ok(MergeOutcome::Limited(detail)) => {
                // A certain non-merge: the entry stays merging, and the
                // request is sent again after the cooldown.
                e["merge"]["attempts"] = json!(0);
                e["merge"]["notSent"] = json!(0);
                if let Some(put) = e["merge"]["puts"].as_array_mut().and_then(|p| p.last_mut()) {
                    put["limited"] = json!(detail);
                }
                e["detail"] = json!(format!("GitHub's rate limit refused the merge request, so nothing merged; Core sends it again after the cooldown ({detail})."));
                e["nextCheck"] = json!((now_epoch + 60).max(cooldown + 5));
            }
            Ok(MergeOutcome::NotSent(detail)) => {
                // The request never reached GitHub, so nothing merged: the
                // entry stays merging and tries again shortly.
                e["merge"]["attempts"] = json!(0);
                if let Some(put) = e["merge"]["puts"].as_array_mut().and_then(|p| p.last_mut()) {
                    put["notSent"] = json!(detail);
                }
                let n = e["merge"]["notSent"].as_i64().unwrap_or(0) + 1;
                e["merge"]["notSent"] = json!(n);
                if n >= NOT_SENT_LIMIT {
                    stop(&mut e, "github_unreachable", format!("{n} merge requests could not be sent; nothing merged. The last: {detail}"));
                } else {
                    e["detail"] = json!(format!("The merge request could not be sent ({detail}), so nothing merged; Core tries again shortly."));
                    e["nextCheck"] = json!(now_epoch + 60);
                }
            }
            Ok(MergeOutcome::Unknown(detail)) => {
                urgent = true;
                unknown(self, &tx, &mut e, detail)?;
            }
            Ok(MergeOutcome::Moved(detail) | MergeOutcome::Held(detail) | MergeOutcome::Paused(detail)) => {
                // Nothing was sent: the merge is set aside and every check
                // runs again.
                let old = e["merge"].take();
                e["retiredMerges"] = json!([e["retiredMerges"].as_array().cloned().unwrap_or_default(), vec![old]].concat());
                e["state"] = json!("waiting");
                e["reason"] = json!("waiting");
                e["detail"] = json!(detail);
                e["nextCheck"] = json!(now_epoch + 60);
            }
            Err(error) => {
                let failures = e["readFailures"].as_i64().unwrap_or(0) + 1;
                e["readFailures"] = json!(failures);
                if e["merge"]["attempts"].as_i64().unwrap_or(0) > 0 {
                    // A journaled request may have been sent: never again.
                    urgent = true;
                    unknown(self, &tx, &mut e, format!("The merge request may have been sent, and Core then failed: {error}"))?;
                } else if failures >= READ_FAILURES {
                    // No request was sent: nothing merged.
                    stop(&mut e, "github_unreachable", format!("{failures} reads failed before the merge request was sent; nothing merged. The last: {error}"));
                } else {
                    e["detail"] = json!(format!("Reading GitHub before the merge request failed ({error}); checking again"));
                    e["nextCheck"] = json!(now_epoch + (60i64 << (failures - 1).min(3)).min(600));
                }
            }
        }
        let state = e["state"].as_str().unwrap_or("").to_owned();
        e["evidence"] = record(&e);
        let (reason, detail) = (e["reason"].clone(), e["detail"].clone());
        history(&mut e, &state, &reason, &detail);
        save(&tx, &e)?;
        if state == "stopped" {
            announce(&tx, &e, if urgent { "urgent" } else { "normal" })?;
        }
        tx.commit()?;
        Ok((state == "merged").then_some(e))
    }

    /// The follow-up of a merged entry: its post-check (a failure pauses the
    /// repository), the cleanup of its batch, and main's push CI on the merge
    /// commit (red pauses the repository; the next entry never waits for it).
    pub(super) fn merge_followed(&self, id: &str, attempt: i64, outcome: std::result::Result<Followed, String>) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["attempt"].as_i64() != Some(attempt) || e["state"] != "merged" {
            return Ok(false);
        }
        let now_epoch = epoch();
        e["updatedAt"] = json!(now());
        let sha = e["merge"]["sha"].as_str().unwrap_or("").to_owned();
        let mut announce_as = None;
        match outcome {
            Ok(f) => {
                e["readFailures"] = json!(0);
                if let Some(c) = f.cleanup {
                    if c["error"].is_string() {
                        // Retried later, by this follow-up or the cleanup pass.
                        e["batch"]["cleanup"] = json!("pending");
                        e["batch"]["cleanupError"] = c["error"].clone();
                        e["batch"]["cleanupAt"] = c["at"].clone();
                    } else {
                        e["batch"]["closed"] = c["closed"].clone();
                        e["batch"]["deleted"] = c["deleted"].clone();
                        if c["closed"] == true && c["deleted"] == true {
                            e["batch"]["cleanup"] = json!("done");
                            e["batch"]["cleanedAt"] = c["at"].clone();
                        }
                    }
                }
                match f.post {
                    Some(Ok(())) => {
                        e["merge"]["post"] = json!({"ok":true,"commit":f.merge_commit,"at":now()});
                        announce_as = Some("normal");
                    }
                    Some(Err(hold)) => {
                        let detail = match hold { Hold::Stop(_, d) | Hold::Wait(d) => d };
                        e["merge"]["post"] = json!({"ok":false,"commit":f.merge_commit,"detail":detail,"at":now()});
                        pause(self, &tx, &e, "post_check_failed", &sha, &Value::Null, &detail)?;
                        stop(&mut e, "post_check_failed", detail);
                        announce_as = Some("urgent");
                    }
                    None => {}
                }
                if e["state"] == "merged" && announce_as.is_none() {
                    match f.main_ci.filter(|run| run["status"] == "completed") {
                        Some(run) => {
                            let conclusion = run["conclusion"].as_str().unwrap_or("").to_owned();
                            e["merge"]["mainCi"] = json!({"run":run["id"],"attempt":run["run_attempt"],"conclusion":conclusion,"url":run["html_url"]});
                            e["state"] = json!("done");
                            e["detail"] = json!(format!("Main's push CI on the merge commit concluded {conclusion}."));
                            let red = matches!(conclusion.as_str(), "failure" | "timed_out" | "startup_failure");
                            if red {
                                e["reason"] = json!("main_red");
                                pause(self, &tx, &e, "main_red", &sha, &run["id"], &format!("Main CI run {} on {} concluded {conclusion} after #{} merged", run["id"], &sha[..12.min(sha.len())], e["number"]))?;
                            }
                            announce_as = Some(if red { "urgent" } else { "normal" });
                        }
                        None => {
                            let waits = e["waits"].as_i64().unwrap_or(0);
                            let since = e["waitingSince"].as_i64().unwrap_or(now_epoch);
                            e["waits"] = json!(waits + 1);
                            e["waitingSince"] = json!(since);
                            e["nextCheck"] = json!(now_epoch + (60i64 << waits.min(3)).min(600));
                            if now_epoch - since > WAIT_LIMIT {
                                e["merge"]["mainCi"] = json!({"conclusion":"unobserved","detail":"No finished push run of CI on the merge commit within six hours"});
                                e["state"] = json!("done");
                                e["detail"] = json!("No finished push run of CI on the merge commit within six hours.");
                                announce_as = Some("urgent");
                            }
                        }
                    }
                }
            }
            Err(error) => {
                let failures = e["readFailures"].as_i64().unwrap_or(0) + 1;
                e["readFailures"] = json!(failures);
                e["nextCheck"] = json!(now_epoch + (60i64 << (failures - 1).min(3)).min(600));
                if failures >= READ_FAILURES && e["merge"]["post"].is_null() {
                    // The merge commit's parents and tree were never checked:
                    // nothing merges on top of it until a person has looked.
                    let detail = format!("{failures} reads of the merge commit failed, so its parents and tree were never checked; the last: {error}");
                    pause(self, &tx, &e, "post_check_unverified", &sha, &Value::Null, &detail)?;
                    stop(&mut e, "post_check_unverified", detail);
                    announce_as = Some("urgent");
                } else if failures >= READ_FAILURES {
                    e["merge"]["mainCi"] = json!({"conclusion":"unobserved","detail":error});
                    e["state"] = json!("done");
                    e["detail"] = json!(format!("{failures} reads after the merge failed; the last: {error}"));
                    announce_as = Some("urgent");
                }
            }
        }
        let state = e["state"].as_str().unwrap_or("").to_owned();
        if state == "done" && e["batch"]["cleanup"] == "pending" {
            e["nextCheck"] = json!(now_epoch + 60);
        }
        e["evidence"] = record(&e);
        if announce_as.is_some() {
            let (reason, detail) = (e["reason"].clone(), e["detail"].clone());
            history(&mut e, &state, &reason, &detail);
        }
        save(&tx, &e)?;
        if let Some(priority) = announce_as {
            announce(&tx, &e, priority)?;
        }
        tx.commit()?;
        Ok(announce_as.is_some())
    }

    /// A new batch, or a step of one, written to GitHub: recorded before the
    /// next write. False when a cancel or retry moved the entry on.
    pub(super) fn merge_batch(&self, id: &str, attempt: i64, batch: Value) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["attempt"].as_i64() != Some(attempt) || !matches!(e["state"].as_str(), Some("queued" | "waiting" | "ready")) {
            return Ok(false);
        }
        e["batch"] = batch;
        save(&tx, &e)?;
        tx.commit()?;
        Ok(true)
    }
    /// A batch on an older main, removed before a new one is built.
    pub(super) fn merge_batch_retired(&self, id: &str, attempt: i64, cleanup: Value) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["attempt"].as_i64() != Some(attempt) {
            return Ok(());
        }
        let mut old = e["batch"].take();
        old["closed"] = cleanup["closed"].clone();
        old["deleted"] = cleanup["deleted"].clone();
        old["cleanup"] = json!("done");
        e["retiredBatches"] = json!([e["retiredBatches"].as_array().cloned().unwrap_or_default(), vec![old]].concat());
        save(&tx, &e)?;
        tx.commit()?;
        Ok(())
    }
    /// The removal of a stopped, cancelled or ended entry's batch.
    pub(super) fn merge_cleaned(&self, id: &str, outcome: std::result::Result<Value, String>) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["batch"]["cleanup"] != "pending" {
            return Ok(());
        }
        match outcome {
            Ok(c) => {
                e["batch"]["closed"] = c["closed"].clone();
                e["batch"]["deleted"] = c["deleted"].clone();
                e["batch"]["cleanup"] = json!("done");
                e["batch"]["cleanedAt"] = c["at"].clone();
                let (state, reason) = (e["state"].as_str().unwrap_or("").to_owned(), e["reason"].clone());
                history(&mut e, &state, &reason, &json!("Core removed its batch branch and PR"));
            }
            // The switch being off, or GitHub's rate limit, is a wait and no
            // failure: the removal stays pending, and turning the switch on
            // makes it due at once.
            Err(error) if error.starts_with("merge_queue_disabled") || error.starts_with("rate_limited") => {
                e["batch"]["cleanupError"] = json!(error);
                e["batch"]["cleanupAt"] = json!(now());
                e["nextCheck"] = json!(epoch() + 600);
            }
            Err(error) => {
                let failures = e["batch"]["cleanupFailures"].as_i64().unwrap_or(0) + 1;
                e["batch"]["cleanupFailures"] = json!(failures);
                e["batch"]["cleanupError"] = json!(error);
                if failures >= READ_FAILURES {
                    e["batch"]["cleanup"] = json!("failed");
                    let text = format!(
                        "Core stopped trying to remove its batch after {failures} failures in a row; the last: {error}. Remove the branch {} and PR #{} by hand.",
                        e["batch"]["branch"].as_str().unwrap_or("?"),
                        e["batch"]["pr"]
                    );
                    let (state, reason) = (e["state"].as_str().unwrap_or("").to_owned(), e["reason"].clone());
                    history(&mut e, &state, &reason, &json!(text));
                } else {
                    e["nextCheck"] = json!(epoch() + (60i64 << (failures - 1).min(3)).min(600));
                }
            }
        }
        save(&tx, &e)?;
        tx.commit()?;
        Ok(())
    }

    /// Whether `actor` may unpause repository `id`: the user, or a lead of a
    /// Project the repository is linked to. Answers the repository and the
    /// branch whose main the waiting entries are re-anchored at.
    pub(super) fn merge_unpause_allowed(&self, actor: Option<&str>, id: i64) -> Result<(String, String)> {
        let db = self.db.read()?;
        if let Some(agent) = actor {
            let lead: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM agent_roles r JOIN project_agents p ON p.agent_id=r.agent_id AND p.project_id=r.project_id
                 JOIN github_project_repos g ON g.project_id=r.project_id WHERE r.kind='lead' AND r.agent_id=?1 AND g.repo_id=?2)",
                params![agent, id],
                |r| r.get(0),
            )?;
            ensure!(lead, "merge_unpause_not_allowed: only a lead of a Project this repository is linked to, or the user, can unpause its merge queue");
        }
        let r = repository(&db, id)?;
        ensure!(!r["paused"].is_null(), "merge_not_paused: the merge queue of this repository is not paused");
        let name: String = db
            .query_row("SELECT json_extract(data,'$.fullName') FROM github_repositories WHERE id=?1", [id], |r| r.get(0))
            .optional()?
            .context("not_found: no such linked repository")?;
        Ok((name, r["paused"]["base"].as_str().unwrap_or("main").to_owned()))
    }

    /// Unpause repository `id` by hand, re-anchoring every waiting entry at `main`.
    pub(super) fn merge_unpause(&self, actor: Option<&str>, id: i64, request_id: &str, reason: Option<&str>, main: &str) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let input = json!({"requestId":request_id,"repositoryId":id,"reason":reason});
        let receipt_row: Option<String> = tx
            .query_row(
                "SELECT response_json FROM collaboration_requests WHERE actor=?1 AND operation='merge_unpause' AND request_id=?2",
                params![actor_key(actor), request_id],
                |r| r.get(0),
            )
            .optional()?;
        if let Some(answer) = receipt_row {
            return Ok(serde_json::from_str(&answer)?);
        }
        let (author, _) = collab::actor_context(self, &tx, actor)?;
        let by = json!({"by":author.name,"actor":author,"reason":reason});
        let (waiting, accepted) = clear(self, &tx, id, by, main, None)?;
        let answer = json!({"repository":repository(&tx, id)?,"reanchored":waiting.iter().map(|e| e["id"].clone()).collect::<Vec<_>>(),"main":main,"acceptedRun":accepted});
        tx.execute(
            "INSERT INTO collaboration_requests(actor,operation,request_id,input_json,response_json) VALUES(?1,'merge_unpause',?2,?3,?4)",
            params![actor_key(actor), request_id, input.to_string(), answer.to_string()],
        )?;
        tx.commit()?;
        Ok(answer)
    }

    /// The user's switch for one linked repository. Its pause is kept. On,
    /// it makes every batch removal that waited for it due now.
    pub(super) fn merge_set_enabled(&self, repository_id: i64, on: bool) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM github_repositories WHERE id=?1)", [repository_id], |r| r.get(0))?;
        ensure!(known, "not_found: link the repository to a Project first");
        let mut data = repository(&tx, repository_id)?;
        if data["enabled"] != on {
            switched(&mut data, on, "user", if on { "Turned on" } else { "Turned off" });
        }
        data["enabled"] = json!(on);
        data["updatedAt"] = json!(now());
        save_repository(&tx, repository_id, &data)?;
        if on {
            let waiting: Vec<String> = tx
                .prepare("SELECT data FROM merge_entries WHERE repository_id=?1 AND json_extract(data,'$.batch.cleanup')='pending'")?
                .query_map([repository_id], |r| r.get(0))?
                .collect::<rusqlite::Result<_>>()?;
            for raw in waiting {
                let mut e: Value = serde_json::from_str(&raw)?;
                e["nextCheck"] = json!(0);
                save(&tx, &e)?;
            }
        }
        let data = repository(&tx, repository_id)?;
        tx.commit()?;
        Ok(data)
    }
    pub(super) fn merge_repository(&self, repository_id: i64) -> Result<Value> {
        let db = self.db.read()?;
        repository(&db, repository_id)
    }
}

fn may_change(actor: Option<&str>, e: &Value) -> Result<()> {
    ensure!(
        actor.is_none() || (e["release"]["by"]["kind"] == "agent" && e["release"]["by"]["id"] == actor.unwrap_or("")),
        "merge_release_not_allowed: only the Agent that released this merge, or the user, can change it"
    );
    Ok(())
}

/// A release from before Core merged for real cannot be retried into a merge.
fn released_for_merge(e: &Value) -> Result<()> {
    ensure!(
        e["queueVersion"].as_i64().unwrap_or(1) >= QUEUE_VERSION,
        "merge_dry_run_ended: this entry was released before Core merged for real, and that release does not let Core merge; release the PR again"
    );
    Ok(())
}

/// A merge Core sent may have landed but was never verified: the entry stops
/// with merge_unknown, and the repository's queue pauses until a person has
/// looked, so nothing merges on top of it.
fn unknown(store: &Store, db: &Connection, e: &mut Value, detail: String) -> Result<()> {
    let main = e["merge"]["expectedMain"].as_str().unwrap_or("").to_owned();
    let why = format!(
        "#{} may have merged without a check: its merge request got no certain answer ({detail}). A lead or the user checks whether it landed before unpausing",
        e["number"]
    );
    pause(store, db, e, "merge_unknown", &main, &Value::Null, &why)?;
    stop(e, "merge_unknown", detail);
    Ok(())
}

fn wait(e: &mut Value, detail: String, at_least: i64, now_epoch: i64) {
    let waits = e["waits"].as_i64().unwrap_or(0);
    let since = e["waitingSince"].as_i64().unwrap_or(now_epoch);
    e["waits"] = json!(waits + 1);
    e["waitingSince"] = json!(since);
    e["nextCheck"] = json!((now_epoch + (60i64 << waits.min(3)).min(600)).max(at_least));
    if now_epoch - since > WAIT_LIMIT {
        stop(e, "wait_timeout", format!("Still waiting after six hours: {detail}"));
    } else {
        e["state"] = json!("waiting");
        e["reason"] = json!("waiting");
        e["detail"] = json!(detail);
    }
}
fn failed_read(e: &mut Value, error: String, now_epoch: i64) {
    let failures = e["readFailures"].as_i64().unwrap_or(0) + 1;
    e["readFailures"] = json!(failures);
    if failures >= READ_FAILURES {
        stop(e, "github_unreachable", format!("{failures} reads in a row failed; the last: {error}"));
    } else {
        wait(e, format!("A GitHub read failed ({error}); checking again"), 0, now_epoch);
    }
}
