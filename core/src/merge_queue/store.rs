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
/// While a CI run is still going, on the head or the batch, or main's push CI
/// on the merge commit, the entry is read again at least this often, so its
/// end is seen soon (YN-33, trial YN-26 finding 2): reads keep their ETags, and
/// an unchanged answer is a 304.
const RUNNING_CI: i64 = 120;
const RUNNING_MAIN_CI: i64 = 60;
/// Consecutive failed reads before an entry stops.
const READ_FAILURES: i64 = 8;
/// Consecutive merge requests that could not be sent before an entry stops.
const NOT_SENT_LIMIT: i64 = 5;
/// The next check of an entry that waits for the user, not for a time: one
/// that passed every check while the switch is off. Turning the switch on
/// makes it due (`merge_set_enabled`).
const UNTIL_SWITCHED_ON: i64 = i64::MAX;
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
/// When the entry is next due: its own next check, or earlier when a tag for
/// its release (YN-33) is due first. A tag has its own time (`grouping.nextAt`),
/// so an ended entry is due only for it; a pass that is due only for the tag
/// leaves the follow-up and the cleanup to their own time (`tick`).
fn due_at(e: &Value) -> i64 {
    let own = e["nextCheck"].as_i64().unwrap_or(0);
    if e["grouping"]["state"] != "pending" {
        return own;
    }
    let tag = e["grouping"]["nextAt"].as_i64().unwrap_or(0);
    let rest = matches!(e["state"].as_str(), Some("queued" | "waiting" | "ready" | "merging" | "merged")) || e["batch"]["cleanup"] == "pending";
    if rest { own.min(tag) } else { tag }
}
fn save(db: &Connection, e: &Value) -> Result<()> {
    // A revert entry's number becomes its revert PR's once Core opened it.
    db.execute(
        "UPDATE merge_entries SET state=?1,next_check=?2,data=?3,number=COALESCE(?5,number) WHERE id=?4",
        params![e["state"].as_str(), due_at(e), e.to_string(), e["id"].as_str(), e["number"].as_i64()],
    )?;
    // A chain step that stopped or was cancelled left the chain: the step
    // after it rebuilds now, not after its backoff (YN-18 S2e).
    if e["batch"]["chain"].is_object() && matches!(e["state"].as_str(), Some("stopped" | "cancelled")) {
        next_chain_step(db, e["id"].as_str().unwrap_or(""))?;
    }
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
    if !v["landing"].is_string() {
        v["landing"] = json!(super::landing::DEFAULT);
    }
    if !v["policy"].is_string() {
        v["policy"] = json!(checks::STRICT);
    }
    // YN-18 S2d-2: the user's consent to one-step reverts, and to Core
    // reverting on its own; both off until the user turns them on.
    // YN-33: the user's consent to tagging merged PRs for their release
    // (milestone and task label); off until the user turns it on.
    for key in ["revert", "autoRevert", "grouping"] {
        if !v[key].is_boolean() {
            v[key] = json!(false);
        }
    }
    Ok(v)
}
/// A revert entry passes the main_red pause of the merge it reverts, and no
/// other pause (YN-18 S2d-2): it is what ends that pause.
pub(super) fn revert_passes(e: &Value, paused: &Value) -> bool {
    e["kind"] == "revert" && paused["reason"] == "main_red" && paused["entryId"] == e["revert"]["of"] && e["revert"]["of"].is_string()
}
/// What the mails about a red main after a merge say about reverting it.
fn revert_hint(db: &Connection, e: &Value) -> Result<String> {
    if e["kind"] == "revert" {
        return Ok(String::new());
    }
    let r = repository(db, e["repositoryId"].as_i64().unwrap_or(0))?;
    Ok(if e["revertedBy"].is_string() {
        format!(" Core started its revert (entry {}), as the user's automatic revert setting asks.", e["revertedBy"].as_str().unwrap_or("?"))
    } else if r["revert"] == true {
        format!(" One step reverts it: merge_revert with entry {} (a lead of the repository's Projects), or Revert in Jobs → Merge queue (the user).", e["id"].as_str().unwrap_or("?"))
    } else {
        " Reverts are off for this repository; the user can turn them on in Settings → Projects → its Project → Repositories for a one-step revert.".to_owned()
    })
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

/// Every completed review round of a PR link (on any task) at `head`, oldest
/// first (YN-12 item 1): a P0–P2 finding in any of them holds the head back.
fn rounds_at(db: &Connection, link: &str, head: &str) -> Result<Vec<Value>> {
    let mut q = db.prepare(
        "SELECT data FROM pr_reviews WHERE link_id=?1 AND status='completed' AND json_extract(data,'$.headSha')=?2 ORDER BY rowid",
    )?;
    let rows = q
        .query_map(params![link, head], |r| r.get::<_, String>(0))?
        .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
        .collect();
    rows
}
/// Every completed review round at `head` on any PR of the repository (YN-33):
/// a merged-in head counts as reviewed by a passing one of them.
fn rounds_in_repository(db: &Connection, repository_id: i64, head: &str) -> Result<Vec<Value>> {
    let mut q = db.prepare(
        "SELECT link_id,data FROM pr_reviews WHERE link_id LIKE ?1 AND status='completed' AND json_extract(data,'$.headSha')=?2 ORDER BY rowid",
    )?;
    let rows = q
        .query_map(params![format!("{repository_id}:pull:%"), head], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
        .map(|r| {
            let (link, data) = r?;
            let mut round = serde_json::from_str::<Value>(&data)?;
            round["linkId"] = json!(link);
            Ok(round)
        })
        .collect();
    rows
}
/// Every completed round of this PR at a head the review check judges for
/// `entry`: the head the last round reviewed and the released head, and for a
/// head that adds only merges (YN-33), each merge commit of its proof. A
/// P0–P2 finding at any of them holds the release back: another round of
/// an earlier head never clears it.
fn rounds_at_heads(db: &Connection, link: &str, reviewed: &str, entry: &Value) -> Result<Vec<Value>> {
    let mut heads: Vec<String> = vec![reviewed.to_owned()];
    let merges = entry["reviewMerges"]["merges"].as_array().into_iter().flatten().filter_map(|m| m["commit"].as_str());
    for head in entry["headSha"].as_str().into_iter().chain(merges) {
        if !heads.iter().any(|h| h == head) {
            heads.push(head.to_owned());
        }
    }
    let mut rounds = Vec::new();
    for head in &heads {
        rounds.extend(rounds_at(db, link, head)?);
    }
    Ok(rounds)
}
/// The rounds the review check reads for `entry` (YN-33): every completed
/// round at the head the last round reviewed, and for each merged-in head the
/// entry's proof calls reviewed, every completed round at it in the repository.
fn merged_rounds(db: &Connection, entry: &Value) -> Result<Vec<(String, Vec<Value>)>> {
    let repository_id = entry["repositoryId"].as_i64().unwrap_or(0);
    let mut out = Vec::new();
    for m in entry["reviewMerges"]["merges"].as_array().into_iter().flatten().filter(|m| m["why"]["kind"] == "reviewed") {
        let sha = m["mergedIn"].as_str().unwrap_or("").to_owned();
        let rounds = rounds_in_repository(db, repository_id, &sha)?;
        out.push((sha, rounds));
    }
    Ok(out)
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
    /// The head the last round reviewed, when it is not the released head: the
    /// release then needs the proof that the head adds only merges (YN-33).
    pub reviewed: Option<String>,
    pub task: String,
    pub reference: String,
    pub repository_id: i64,
    pub repository: String,
    pub number: u64,
    pub link: String,
    pub author: TaskActor,
    pub source: Value,
    /// The acknowledged findings (YN-67), as resolved against the last round.
    pub findings: Option<Vec<Value>>,
}
/// `proof`: the entry's proof that the released head is the reviewed head
/// plus merges (YN-33), once read; before it is, the reviewed head's round is
/// checked alone and the plan names that head. `binaries`: the acknowledged
/// binary files (YN-52), as listed before their content is read, and as read
/// at the released head (each with its blob) once it is.
fn plan(store: &Store, db: &Connection, actor: Option<&str>, input: &Enqueue, proof: Option<&Value>, binaries: Option<&Value>) -> Result<Plan> {
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
        "merge_queue_disabled: the merge queue is off for {repository}; only the user can turn it on, in Settings → Projects → its Project → Repositories"
    );
    let (latest, running) = review(db, &link)?;
    let reviewed = latest.as_ref().and_then(|r| r["headSha"].as_str()).unwrap_or(&input.head_sha).to_owned();
    let later = reviewed != input.head_sha && !running;
    // P2 findings the user accepted (YN-67), each bound to the last round and,
    // for a lead, to the user's reply that names it.
    let findings = match (&input.acknowledge_findings, &latest) {
        (None, _) => None,
        (Some(_), None) => bail!("findings_refused: PR #{number} has no completed review round whose findings could be acknowledged"),
        (Some(listed), Some(round)) => {
            let home = project.clone().unwrap_or_default();
            let reply = |key: &str| crate::project_brief::cited_reply(db, &home, key);
            match super::findings::resolve(listed, round, number, actor.is_none(), &reply)? {
                Ok(items) => Some(items),
                Err(why) => bail!("findings_refused: {why}"),
            }
        }
    };
    let mut candidate = match proof {
        Some(proof) => json!({"headSha":input.head_sha,"repositoryId":repository_id,"reviewMerges":proof}),
        // Before the proof is read, only the reviewed head's round is checked.
        None if later => json!({"headSha":input.head_sha,"reviewMerges":{"head":input.head_sha,"reviewedHead":reviewed,"merges":[]}}),
        None => json!({"headSha":input.head_sha}),
    };
    if let Some(files) = binaries {
        candidate["binaries"] = json!({"files":files});
    }
    if let Some(items) = &findings {
        candidate["acknowledgedFindings"] = json!({"items":items});
    }
    let at_heads = rounds_at_heads(db, &link, &reviewed, &candidate)?;
    let merged = merged_rounds(db, &candidate)?;
    match checks::review(&candidate, latest.as_ref(), running, &at_heads, &merged) {
        Ok(_) => {}
        Err(Hold::Wait(detail)) => bail!("review_running: {detail}"),
        Err(Hold::Stop(reason, detail)) => bail!("{reason}: {detail}"),
    }
    // An acknowledgement only ever stands in for files a round could not
    // read (YN-52): one for a round that passes by itself lists extra files.
    if let Some(r) = latest.as_ref().filter(|r| binaries.is_some() && crate::pr_review::policy::passes(r)) {
        bail!(
            "binaries_refused: the last completed review round ({}) passes by itself, so it left no binary file to acknowledge; release without acknowledgeBinaries",
            r["id"].as_str().unwrap_or("?")
        );
    }
    if let Some(r) = latest.as_ref().filter(|r| findings.is_some() && crate::pr_review::policy::passes(r)) {
        bail!(
            "findings_refused: the last completed review round ({}) passes by itself, so it has no finding to acknowledge; release without acknowledgeFindings",
            r["id"].as_str().unwrap_or("?")
        );
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
        reviewed: later.then_some(reviewed),
        task,
        reference,
        repository_id,
        repository,
        number,
        link,
        author,
        source,
        findings,
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
        "release":e["release"],"binaries":e["binaries"],"acknowledgedFindings":e["acknowledgedFindings"],"review":last["review"],"main":last["main"],"gate":last["gate"],"mergeRef":last["mergeRef"],"policy":last["policy"],"checkedAt":last["checkedAt"],
        "batch":e["batch"],"merge":e["merge"],"grouping":e["grouping"],
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
        (Some("merged"), _) if e["kind"] == "revert" => format!(
            "Merge queue: merged Core's revert PR #{n} as {}, reverting #{} (merge commit {}). Post-check: parents main {} and the revert head, tree as built. Core now follows main's push CI on it; green ends the repository's pause. Entry {id}.",
            short(&m["sha"]), e["revert"]["pr"], short(&e["revert"]["bad"]), short(&m["expectedMain"])),
        (Some("done"), _) if e["kind"] == "revert" => format!(
            "Merge queue: main's push CI on the revert of #{} ({}) concluded {}.{} Entry {id}.",
            e["revert"]["pr"], short(&m["sha"]), m["mainCi"]["conclusion"].as_str().unwrap_or("?"),
            if e["reason"] == "main_red" { " Main is still red; the repository's queue stays paused until a lead or the user unpauses it." } else { " The repository's queue is unpaused." }),
        (Some("merged"), _) if gate["kind"] == "relaxed" => format!(
            "Merge queue: merged #{n} at {head} as {}, a merge commit pinned to that head, under the relaxed policy. Gate: the PR's own CI green at the head, and Core's own merge of the head into main {} clean (tree {}); CI did not test that merge. Post-check: parents main {} and the head, tree as Core's merge. Core now follows main's push CI on it; red pauses the queue. Entry {id}: merge_get(entryId) has the evidence record.",
            short(&m["sha"]), short(&m["expectedMain"]), short(&gate["tree"]), short(&m["expectedMain"])),
        (Some("merged"), _) => format!(
            "Merge queue: merged #{n} at {head} as {}, a merge commit pinned to that head. Gate: {} (tree {}), with every CI job on exactly that merge. Post-check: parents main {} and the head, tree as tested. Core now follows main's push CI on it. Entry {id}: merge_get(entryId) has the evidence record.",
            short(&m["sha"]), gate["kind"].as_str().unwrap_or("?"), short(&gate["tree"]), short(&m["expectedMain"])),
        (Some("done"), _) => format!(
            "Merge queue: main's push CI on {} (#{n}) concluded {}.{}{} Entry {id}.",
            short(&m["sha"]), m["mainCi"]["conclusion"].as_str().unwrap_or("?"),
            if e["reason"] == "main_red" { " The repository's queue is paused until a lead or the user unpauses it, or CI on a newer main is green." } else { "" },
            if e["reason"] == "main_red" { revert_hint(db, e)? } else { String::new() }),
        (_, Some("batch_failed")) => format!(
            "Merge queue: #{n} at {head} stopped (batch_failed): CI on its batch failed: {}. Core merged nothing and removes its batch; entries after it in the chain are rebuilt without it. Next: if the failure is the PR's own, the executor fixes it, one review round runs at the new head, and the lead releases that head; if a job failed for another reason, merge_retry checks the same head again on a new batch. Entry {id}.",
            e["detail"].as_str().unwrap_or("")),
        (_, Some("conflict")) => format!(
            "Merge queue: #{n} at {head} stopped (conflict): {}. Core merged nothing{}. Next: the task's executor merges the current main into the PR branch, resolves the conflict and pushes; one review round at the new head; then the lead releases the new head (merge_enqueue with its headSha). merge_retry cannot help, since the head changes. Entry {id}.",
            e["detail"].as_str().unwrap_or(""),
            if e["batch"].is_object() { " and removes its own batch branch" } else { "" }),
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
        "Merge queue: {} is paused ({reason}) by entry {} for #{}: {detail}. No entry merges until a lead or the user unpauses it (merge_unpause){}.{}",
        e["repository"].as_str().unwrap_or("?"), e["id"].as_str().unwrap_or("?"), e["number"],
        if reason == "main_red" { ", or CI on a newer main is green" } else { "" },
        if reason == "main_red" && e["state"] == "done" { revert_hint(db, e)? } else { String::new() }
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
/// A place in the repository's chain of batches (YN-18 S2e).
pub(super) enum Join {
    /// Build the batch on this step: its chain record (id, step, base, prev).
    Step(Value),
    /// The chain is full: the entry waits.
    Full(String),
}

/// What journaling a merge request came to.
pub(super) enum Journal {
    /// Journaled: the request may go.
    Journaled,
    /// The entry is no longer merging.
    NotMerging,
    /// The repository's queue is paused: nothing journaled, nothing sent.
    Paused(String),
    /// The landing policy is no longer the one the merge was checked under:
    /// nothing journaled, nothing sent; every check runs again (S2d-1 R1).
    PolicyChanged(String),
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
    /// The newest completed round of the PR, whether one is running, every
    /// completed round of it at the heads the check judges (`rounds_at_heads`),
    /// and the rounds at each head the entry's proof calls reviewed (YN-33).
    pub(super) fn merge_review(&self, entry: &Value) -> Result<(Option<Value>, bool, Vec<Value>, Vec<(String, Vec<Value>)>)> {
        let db = self.db.read()?;
        let link = entry["linkId"].as_str().context("The entry has no PR link")?;
        let (latest, running) = review(&db, link)?;
        let reviewed = latest.as_ref().and_then(|r| r["headSha"].as_str()).or(entry["headSha"].as_str()).unwrap_or("").to_owned();
        Ok((latest, running, rounds_at_heads(&db, link, &reviewed, entry)?, merged_rounds(&db, entry)?))
    }
    /// A passing completed round at `head` on any PR of the repository with no
    /// P0–P2 finding in any round there (YN-33): the newest such round, with
    /// its link and base.
    pub(super) fn merge_reviewed_head(&self, repository_id: i64, head: &str) -> Result<Option<Value>> {
        let db = self.db.read()?;
        let rounds = rounds_in_repository(&db, repository_id, head)?;
        let blocking = rounds.iter().any(|r| r["findings"].as_array().into_iter().flatten().any(|f| f["priority"].as_u64().is_some_and(|p| p <= 2)));
        if blocking {
            return Ok(None);
        }
        Ok(rounds.into_iter().rev().find(crate::pr_review::policy::passes))
    }

    /// The release's checks before anything is read from GitHub, or the
    /// entry an earlier request with this requestId made.
    pub(super) fn merge_release_plan(&self, actor: Option<&str>, input: &Enqueue) -> Result<Result<Plan, Value>> {
        let db = self.db.read()?;
        let value = serde_json::to_value(input)?;
        if let Some(old) = previous(&db, actor, "merge_enqueue", &input.request_id, &value)? {
            return Ok(Err(old));
        }
        let listed = input.acknowledge_binaries.as_ref().map(|files| json!(files));
        Ok(Ok(plan(self, &db, actor, input, None, listed.as_ref())?))
    }

    /// Commit a release, checking everything again inside the transaction.
    /// `binaries`: each acknowledged binary file as read at the released head.
    pub(super) fn merge_enqueue(&self, actor: Option<&str>, input: &Enqueue, pr: &Value, main: &str, proof: Option<Value>, binaries: Option<Value>) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let value = serde_json::to_value(input)?;
        if let Some(old) = previous(&tx, actor, "merge_enqueue", &input.request_id, &value)? {
            return Ok(old);
        }
        ensure!(binaries.is_some() == input.acknowledge_binaries.is_some(), "The acknowledged binary files were not read at the released head");
        let p = plan(self, &tx, actor, input, proof.as_ref(), binaries.as_ref())?;
        // The head the last round reviewed did not change since the proof was
        // read; a release needing one carries it.
        ensure!(p.reviewed.is_none() || proof.is_some(), "review_not_passing: the last review round no longer reviewed the head the proof was read for; release again");
        // A round at the released head itself since then needs no proof.
        let proof = proof.filter(|_| p.reviewed.is_some());
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
        let binaries = binaries.map(|files| json!({"by":p.author,"at":at,"files":files}));
        let findings = p.findings.as_ref().map(|items| json!({"by":p.author,"at":at,"items":items}));
        let e = json!({"id":id,"entryId":id,"taskId":p.task,"taskReference":p.reference,"repositoryId":p.repository_id,
            "repository":p.repository,"number":p.number,"url":format!("https://github.com/{}/pull/{}",p.repository,p.number),
            "linkId":p.link,"headSha":input.head_sha,"baseBranch":pr["base"]["ref"],"mainAtRelease":main,"mainAnchoredAt":at,
            "requireWorkflows":input.require_workflows.clone().unwrap_or_default(),"note":input.note,"reviewMerges":proof,"binaries":binaries,"acknowledgedFindings":findings,
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
        let merges = match &e["reviewMerges"]["merges"] {
            Value::Array(m) => format!(" Its last review round read {}; this head adds only {} merge(s) of heads that need no review of their own, each redone by Core with the same tree.",
                short(&e["reviewMerges"]["reviewedHead"]), m.len()),
            _ => String::new(),
        };
        let acknowledged = match e["binaries"]["files"].as_array() {
            Some(files) => format!(
                " The release acknowledges {} binary file(s) its review round could not read, each read at this head by Core: {}.",
                files.len(),
                files
                    .iter()
                    .map(|f| format!("{} ({}, {} bytes, SHA-256 {})", f["path"].as_str().unwrap_or("?"), f["format"].as_str().unwrap_or("?"), f["bytes"], f["sha256"].as_str().unwrap_or("?")))
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            None => String::new(),
        };
        // Each acknowledged finding, and the user's reply that accepts it.
        let accepted = match e["acknowledgedFindings"]["items"].as_array() {
            Some(items) => format!(
                " The release acknowledges {} P2 finding(s) of review round {} as intended: {}.",
                items.len(),
                items[0]["round"],
                items
                    .iter()
                    .map(|i| {
                        let cited = &i["userReply"];
                        let why = if cited.is_object() {
                            format!(", citing the user's reply to `{}` ({}): “{}”", cited["key"].as_str().unwrap_or("?"), cited["repliedAt"].as_str().unwrap_or("?"),
                                cited["reply"].as_str().unwrap_or_default().chars().take(200).collect::<String>())
                        } else {
                            ", by the user".to_owned()
                        };
                        format!("“{}” ({}:{}){why}", i["title"].as_str().unwrap_or("?"), i["path"].as_str().unwrap_or("?"), i["startLine"])
                    })
                    .collect::<Vec<_>>()
                    .join("; ")
            ),
            None => String::new(),
        };
        collab::activity(&tx, &p.task, "comment", &p.author, &p.source, json!({"mergeEntryId":id,
            "body":format!("Merge queue: released #{} at {head} on main {} (entry {id}). The release says the review pair is complete.{merges}{acknowledged}{accepted} Core checks the last round at this head, CI and main, and merges the PR as a merge commit pinned to this head once every check holds, while the queue is on for {}.",
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
    /// reconcile, a merge to follow, a batch of Core's own to remove, or a
    /// merge to tag for its release (YN-33).
    pub(super) fn merge_due(&self) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let mut q = db.prepare(
            "SELECT data FROM merge_entries WHERE next_check<=?1
             AND (state IN ('queued','waiting','ready','merging','merged') OR json_extract(data,'$.batch.cleanup')='pending'
                  OR json_extract(data,'$.grouping.state')='pending')
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
                        // A check counts only under the policy it ran with: one that
                        // ended after the user changed it is checked again (S2d-1 R1).
                        let policy = r["policy"].as_str().unwrap_or(checks::STRICT);
                        let checked = evidence["policy"].as_str().unwrap_or(checks::STRICT);
                        let (state, detail, next) = if checked != policy {
                            ("waiting", format!("The landing policy changed to {policy} while this check ran under {checked}; it is checked again under {policy}."), now_epoch)
                        } else if r["enabled"] != true {
                            ("ready", format!("Every check held, but the merge queue is off for {}; Core writes nothing to GitHub, and checks it again once the user turns it on.", e["repository"].as_str().unwrap_or("?")), UNTIL_SWITCHED_ON)
                        } else if !r["paused"].is_null() && !revert_passes(&e, &r["paused"]) {
                            ("waiting", format!("Every check held, but the repository's queue is paused ({}).", r["paused"]["reason"].as_str().unwrap_or("?")), now_epoch + 60)
                        } else if super::landing::Landing::named(&r["landing"]).is_none() {
                            ("ready", format!("Every check held, but this Core cannot land with '{}', the landing set for {}; it sends nothing.", r["landing"].as_str().unwrap_or("?"), e["repository"].as_str().unwrap_or("?")), now_epoch + 300)
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
                                "landing":r["landing"],"policy":evidence["policy"],"head":e["headSha"],"attempts":0,"puts":[],"startedAt":now(),"sha":null,"post":null,"mainCi":null});
                        }
                    }
                    Err(Hold::Wait(detail)) => {
                        // While the repository's queue is paused, an entry waits
                        // for the unpause: that time is not part of the wait limit.
                        if !repository(&tx, e["repositoryId"].as_i64().unwrap_or(0))?["paused"].is_null() {
                            e["waitingSince"] = Value::Null;
                        }
                        wait(&mut e, detail, 0, now_epoch);
                        // A wait for GitHub's merge ref is checked again when its
                        // grace ends, not later after the backoff (S2c).
                        if let Some(at) = evidence["mergeRef"]["checkAgainAt"].as_i64().filter(|_| e["state"] == "waiting") {
                            e["nextCheck"] = json!(e["nextCheck"].as_i64().unwrap_or(at).min(at.max(now_epoch)));
                        }
                        // A run still going is read again within two minutes.
                        let running = evidence["ciRunning"] == true || evidence["gate"]["ciRunning"] == true;
                        if running && e["state"] == "waiting" {
                            let at = now_epoch + RUNNING_CI;
                            e["nextCheck"] = json!(e["nextCheck"].as_i64().unwrap_or(at).min(at));
                        }
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
        let r = repository(&tx, e["repositoryId"].as_i64().unwrap_or(0))?;
        let paused = r["paused"].clone();
        if !paused.is_null() && !revert_passes(&e, &paused) {
            return Ok(Journal::Paused(format!(
                "The repository's merge queue is paused ({}) since {}, so the merge request was not sent; the entry waits for the unpause.",
                paused["reason"].as_str().unwrap_or("paused"),
                paused["at"].as_str().unwrap_or("?")
            )));
        }
        let (policy, checked) = (r["policy"].as_str().unwrap_or(checks::STRICT), e["merge"]["policy"].as_str().unwrap_or(checks::STRICT));
        if policy != checked {
            return Ok(Journal::PolicyChanged(format!(
                "The landing policy changed to {policy} after this merge was checked under {checked}, so the merge request was not sent; every check runs again under {policy}."
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
                next_chain_step(&tx, id)?;
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
                        next_chain_step(&tx, id)?;
                        // Only a merge whose post-check held is tagged for its
                        // release (YN-33), and only with the user's consent.
                        if repository(&tx, e["repositoryId"].as_i64().unwrap_or(0))?["grouping"] == true {
                            e["grouping"] = json!({"state":"pending","failures":0,"nextAt":0});
                        }
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
                    let running = f.main_ci.as_ref().is_some_and(|run| run["status"] != "completed");
                    match f.main_ci.filter(|run| run["status"] == "completed") {
                        Some(run) => {
                            let conclusion = run["conclusion"].as_str().unwrap_or("").to_owned();
                            e["merge"]["mainCi"] = json!({"run":run["id"],"attempt":run["run_attempt"],"conclusion":conclusion,"url":run["html_url"]});
                            e["state"] = json!("done");
                            e["detail"] = json!(format!("Main's push CI on the merge commit concluded {conclusion}."));
                            let red = matches!(conclusion.as_str(), "failure" | "timed_out" | "startup_failure");
                            let repository_id = e["repositoryId"].as_i64().unwrap_or(0);
                            let r = repository(&tx, repository_id)?;
                            if red {
                                e["reason"] = json!("main_red");
                                // Core reverts on its own only when the user turned
                                // both reverts and automatic reverts on (S2d-2).
                                if e["kind"] != "revert" && r["revert"] == true && r["autoRevert"] == true {
                                    let made = revert_entry(&tx, &e, &system(), &json!({"mergeQueue":true}), None)?;
                                    e["revertedBy"] = made["id"].clone();
                                }
                                pause(self, &tx, &e, "main_red", &sha, &run["id"], &format!("Main CI run {} on {} concluded {conclusion} after #{} merged", run["id"], &sha[..12.min(sha.len())], e["number"]))?;
                            } else if e["kind"] == "revert" && revert_passes(&e, &r["paused"]) {
                                // The revert landed and main is green: its pause ends.
                                let by = json!({"by":format!("the revert of #{}", e["revert"]["pr"]),"entryId":e["id"]});
                                clear(self, &tx, repository_id, by, &sha, None)?;
                            }
                            announce_as = Some(if red { "urgent" } else { "normal" });
                        }
                        None => {
                            let waits = e["waits"].as_i64().unwrap_or(0);
                            let since = e["waitingSince"].as_i64().unwrap_or(now_epoch);
                            e["waits"] = json!(waits + 1);
                            e["waitingSince"] = json!(since);
                            // Once main's push CI on the merge commit runs, it is
                            // read every minute until it ends; before, with the backoff.
                            let pace = if running { RUNNING_MAIN_CI } else { (60i64 << waits.min(3)).min(600) };
                            e["nextCheck"] = json!(now_epoch + pace);
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
            // Turning the switch on makes due at once every removal it held up
            // and every entry still to be checked or merged, a ready one
            // waiting for the switch included.
            let waiting: Vec<String> = tx
                .prepare("SELECT data FROM merge_entries WHERE repository_id=?1 AND (json_extract(data,'$.batch.cleanup')='pending' OR state IN ('queued','waiting','ready'))")?
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
    /// The user's choice of how the repository's entries land; journaled with
    /// the switch.
    pub(super) fn merge_set_landing(&self, repository_id: i64, landing: super::landing::Landing) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM github_repositories WHERE id=?1)", [repository_id], |r| r.get(0))?;
        ensure!(known, "not_found: link the repository to a Project first");
        let mut data = repository(&tx, repository_id)?;
        if data["landing"] != landing.name() {
            let on = data["enabled"] == true;
            switched(&mut data, on, "user", &format!("Landing set to {}", landing.name()));
        }
        data["landing"] = json!(landing.name());
        data["updatedAt"] = json!(now());
        save_repository(&tx, repository_id, &data)?;
        let data = repository(&tx, repository_id)?;
        tx.commit()?;
        Ok(data)
    }
    /// The user's landing policy for a repository (YN-18 S2d): `strict`, CI on
    /// the current main through batches, or `relaxed`, the PR's own CI and a
    /// clean merge with the current main. Journaled with the switch.
    pub(super) fn merge_set_policy(&self, repository_id: i64, policy: &str) -> Result<Value> {
        ensure!(
            matches!(policy, checks::STRICT | checks::RELAXED),
            "invalid_input: policy is strict or relaxed, not {policy:?}"
        );
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM github_repositories WHERE id=?1)", [repository_id], |r| r.get(0))?;
        ensure!(known, "not_found: link the repository to a Project first");
        let mut data = repository(&tx, repository_id)?;
        if data["policy"] != policy {
            let on = data["enabled"] == true;
            switched(&mut data, on, "user", &format!("Policy set to {policy}"));
        }
        data["policy"] = json!(policy);
        data["updatedAt"] = json!(now());
        save_repository(&tx, repository_id, &data)?;
        // Every entry still to be checked is checked again under the new policy.
        let waiting: Vec<String> = tx
            .prepare("SELECT data FROM merge_entries WHERE repository_id=?1 AND state IN ('queued','waiting','ready')")?
            .query_map([repository_id], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for raw in waiting {
            let mut e: Value = serde_json::from_str(&raw)?;
            e["nextCheck"] = json!(0);
            save(&tx, &e)?;
        }
        let data = repository(&tx, repository_id)?;
        tx.commit()?;
        Ok(data)
    }
    /// Whether `actor` may revert entry `id` (see `revert_allowed`).
    pub(super) fn merge_revert_allowed(&self, actor: Option<&str>, id: &str) -> Result<Value> {
        let db = self.db.read()?;
        revert_allowed(&db, actor, id)
    }

    /// Ask for the revert of entry `id`; a retry with the same requestId gets
    /// the revert entry it made back.
    pub(super) fn merge_revert(&self, actor: Option<&str>, request_id: &str, id: &str, reason: Option<&str>) -> Result<Value> {
        let input = json!({"requestId":request_id,"entryId":id,"reason":reason});
        {
            let db = self.db.read()?;
            if let Some(old) = previous(&db, actor, "merge_revert", request_id, &input)? {
                return Ok(old);
            }
        }
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        if let Some(old) = previous(&tx, actor, "merge_revert", request_id, &input)? {
            return Ok(old);
        }
        // Checked inside the write, so two requests at once cannot both pass
        // the one-revert-at-a-time rule (S2d-2 R1, P3).
        let original = revert_allowed(&tx, actor, id)?;
        let (author, source) = collab::actor_context(self, &tx, actor)?;
        let e = revert_entry(&tx, &original, &author, &source, reason)?;
        receipt(&tx, actor, "merge_revert", request_id, &input, e["id"].as_str().unwrap_or(""))?;
        tx.commit()?;
        Ok(e)
    }

    /// The revert PR Core opened for revert entry `id`: the entry now holds it.
    pub(super) fn merge_revert_opened(&self, id: &str, attempt: i64, number: u64, head: &str) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["attempt"].as_i64() != Some(attempt) || !matches!(e["state"].as_str(), Some("queued" | "waiting" | "ready")) {
            return Ok(false);
        }
        e["number"] = json!(number);
        e["headSha"] = json!(head);
        e["url"] = json!(format!("https://github.com/{}/pull/{number}", e["repository"].as_str().unwrap_or("")));
        let text = format!("Merge queue: Core opened revert PR #{number} at {} for the revert of #{} (entry {id}).", short(&json!(head)), e["revert"]["pr"]);
        let state = e["state"].as_str().unwrap_or("queued").to_owned();
        history(&mut e, &state, &Value::Null, &json!(text));
        save(&tx, &e)?;
        collab::activity(&tx, e["taskId"].as_str().unwrap_or(""), "comment", &system(), &json!({"mergeEntryId":id}),
            json!({"mergeEntryId":id,"body":text}))?;
        tx.commit()?;
        Ok(true)
    }

    /// The user's consent to reverts for a repository, and to Core reverting
    /// on its own (YN-18 S2d-2); automatic reverts need reverts on.
    pub(super) fn merge_set_reverts(&self, repository_id: i64, revert: Option<bool>, auto: Option<bool>) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM github_repositories WHERE id=?1)", [repository_id], |r| r.get(0))?;
        ensure!(known, "not_found: link the repository to a Project first");
        let mut data = repository(&tx, repository_id)?;
        let on = data["enabled"] == true;
        if let Some(revert) = revert.filter(|v| data["revert"] != *v) {
            switched(&mut data, on, "user", if revert { "Reverts allowed" } else { "Reverts turned off" });
            data["revert"] = json!(revert);
            if !revert && data["autoRevert"] == true {
                data["autoRevert"] = json!(false);
                switched(&mut data, on, "user", "Automatic reverts turned off with reverts");
            }
        }
        if let Some(auto) = auto.filter(|v| data["autoRevert"] != *v) {
            ensure!(!auto || data["revert"] == true, "invalid_input: turn reverts on before automatic reverts");
            switched(&mut data, on, "user", if auto { "Automatic reverts turned on" } else { "Automatic reverts turned off" });
            data["autoRevert"] = json!(auto);
        }
        data["updatedAt"] = json!(now());
        save_repository(&tx, repository_id, &data)?;
        let data = repository(&tx, repository_id)?;
        tx.commit()?;
        Ok(data)
    }
    /// The user's consent to tagging the PRs the queue merged for their
    /// release (YN-33): the newest open milestone and the task's label.
    /// Journaled with the switch.
    pub(super) fn merge_set_grouping(&self, repository_id: i64, grouping: bool) -> Result<Value> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM github_repositories WHERE id=?1)", [repository_id], |r| r.get(0))?;
        ensure!(known, "not_found: link the repository to a Project first");
        let mut data = repository(&tx, repository_id)?;
        if data["grouping"] != grouping {
            let on = data["enabled"] == true;
            switched(&mut data, on, "user", if grouping { "Release grouping turned on" } else { "Release grouping turned off" });
            data["grouping"] = json!(grouping);
        }
        data["updatedAt"] = json!(now());
        save_repository(&tx, repository_id, &data)?;
        let data = repository(&tx, repository_id)?;
        tx.commit()?;
        Ok(data)
    }
    /// What a merged entry is tagged with (YN-33): its task's current key and
    /// title, and whether the user still allows tagging for the repository.
    pub(super) fn merge_grouping_task(&self, task: &str, repository_id: i64) -> Result<(String, String, bool)> {
        let db = self.db.read()?;
        let key = collab::task_number(&db, task)?;
        let title = collab::load_task(&db, task)?.title;
        Ok((key, title, repository(&db, repository_id)?["grouping"] == true))
    }
    /// One attempt to tag a merged entry for its release (YN-33). It never
    /// changes the merge, its state or the queue: a failure is retried later,
    /// and after eight in a row Core stops and says what to set by hand.
    pub(super) fn merge_grouped(&self, id: &str, outcome: std::result::Result<Value, String>) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut e = entry(&tx, id)?;
        if e["grouping"]["state"] != "pending" {
            return Ok(());
        }
        let now_epoch = epoch();
        let n = e["number"].as_u64().unwrap_or(0);
        let (state, reason) = (e["state"].as_str().unwrap_or("").to_owned(), e["reason"].clone());
        let mut comment = None;
        match outcome {
            Ok(done) if done["skipped"] == "off" => {
                e["grouping"] = json!({"state":"off","at":now()});
                history(&mut e, &state, &reason, &json!(format!("Release grouping was turned off before Core tagged #{n}; nothing was tagged")));
            }
            Ok(done) => {
                let milestone = match done["milestone"]["action"].as_str() {
                    Some("none") => "no open milestone".to_owned(),
                    Some("kept") => format!("its own milestone {} kept", done["milestone"]["title"].as_str().unwrap_or("?")),
                    _ => format!("milestone {}", done["milestone"]["title"].as_str().unwrap_or("?")),
                };
                let label = format!("label {}{}", done["label"]["name"].as_str().unwrap_or("?"), if done["label"]["created"] == true { " (created)" } else { "" });
                let text = format!("Tagged #{n} for its release: {milestone}, {label}");
                history(&mut e, &state, &reason, &json!(text));
                if done["milestone"]["action"] == "none" {
                    comment = Some(format!("Merge queue: tagged #{n} with {} only: the repository has no open milestone, so #{n} has none. Set the release's milestone by hand. Entry {id}.",
                        done["label"]["name"].as_str().unwrap_or("?")));
                }
                e["grouping"] = json!({"state":"done","milestone":done["milestone"],"label":done["label"],"at":now()});
            }
            // The switch being off, or GitHub's rate limit, is a wait and no
            // failure, as for removing a batch.
            Err(error) if error.starts_with("merge_queue_disabled") || error.starts_with("rate_limited") => {
                e["grouping"]["error"] = json!(error);
                e["grouping"]["nextAt"] = json!(now_epoch + 600);
            }
            Err(error) if error.starts_with("merge_grouping_off") => {
                e["grouping"] = json!({"state":"off","at":now()});
                history(&mut e, &state, &reason, &json!(format!("Release grouping was turned off before Core tagged #{n}; nothing more was tagged")));
            }
            Err(error) => {
                let failures = e["grouping"]["failures"].as_i64().unwrap_or(0) + 1;
                e["grouping"]["failures"] = json!(failures);
                e["grouping"]["error"] = json!(error);
                if failures >= READ_FAILURES {
                    e["grouping"]["state"] = json!("failed");
                    let text = format!(
                        "Core stopped tagging #{n} for its release after {failures} failures in a row; the last: {error}. The merge stands. Set the release's milestone and the label task:{} on #{n} by hand.",
                        e["taskReference"].as_str().unwrap_or("?")
                    );
                    history(&mut e, &state, &reason, &json!(text));
                    comment = Some(format!("Merge queue: {text} Entry {id}."));
                } else {
                    e["grouping"]["nextAt"] = json!(now_epoch + (60i64 << (failures - 1).min(3)).min(600));
                }
            }
        }
        e["evidence"] = record(&e);
        save(&tx, &e)?;
        if let Some(body) = comment {
            collab::activity(&tx, e["taskId"].as_str().unwrap_or(""), "comment", &system(), &json!({"mergeEntryId":id}),
                json!({"mergeEntryId":id,"body":body}))?;
        }
        tx.commit()?;
        Ok(())
    }
    /// Join entry `id` to the repository's chain of batches at its batch
    /// decision (YN-18 S2e). With no step still to merge or in flight, a new
    /// chain starts on `main`; otherwise the entry is the next step, built on
    /// the last one's batch commit. Steps keep the order they joined in, which
    /// is release order among the entries that reached the batch decision.
    pub(super) fn merge_chain_join(&self, id: &str, attempt: i64, repository_id: i64, main: &str) -> Result<Join> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let e = entry(&tx, id)?;
        ensure!(
            e["attempt"].as_i64() == Some(attempt) && matches!(e["state"].as_str(), Some("queued" | "waiting" | "ready")),
            "merge_moved_on: the entry was cancelled or retried meanwhile"
        );
        let mut r = repository(&tx, repository_id)?;
        let chain = r["chain"].clone();
        let live = chain_live(&tx, &chain, id)?;
        // An entry whose own step still stands where it is keeps its place: a
        // check that stopped before its batch was whole resumes it.
        let own = &e["batch"]["chain"];
        let stands = match live.last() {
            None => own["prev"].is_null() && own["base"] == main,
            Some(tip) => own["prev"] == tip["id"] && own["base"] == tip["batch"]["commit"],
        };
        if own["id"] == chain["id"] && e["batch"]["cleanup"].is_null() && stands && live.len() < checks::CHAIN_STEPS {
            return Ok(Join::Step(own.clone()));
        }
        let link = match live.last() {
            None => {
                let cid = uuid::Uuid::new_v4().to_string();
                r["chain"] = json!({"id":cid,"version":chain["version"].as_i64().unwrap_or(0) + 1,"main":main,"steps":[id],"startedAt":now()});
                json!({"id":cid,"step":1,"base":main,"prev":null,"prevPr":null,"prevTree":null})
            }
            Some(_) if live.len() >= checks::CHAIN_STEPS => {
                return Ok(Join::Full(format!(
                    "The chain of batches is full ({} steps); the entry joins once a step merges or leaves",
                    checks::CHAIN_STEPS
                )));
            }
            Some(tip) => {
                let mut steps: Vec<Value> = chain["steps"].as_array().cloned().unwrap_or_default();
                steps.retain(|s| s != id);
                steps.push(json!(id));
                r["chain"]["steps"] = json!(steps);
                json!({"id":chain["id"],"step":tip["batch"]["chain"]["step"].as_u64().unwrap_or(1) + 1,"base":tip["batch"]["commit"],
                    "prev":tip["id"],"prevPr":tip["number"],"prevTree":tip["batch"]["tree"]})
            }
        };
        save_repository(&tx, repository_id, &r)?;
        tx.commit()?;
        Ok(Join::Step(link))
    }

    /// The entries released before `id` in its repository that are still to
    /// be checked and hold no chain step: a head that contains one of theirs
    /// waits for it to join first (stacks keep their order).
    pub(super) fn merge_earlier_heads(&self, id: &str) -> Result<Vec<Value>> {
        let db = self.db.read()?;
        let e = entry(&db, id)?;
        let rowid: i64 = db.query_row("SELECT rowid FROM merge_entries WHERE id=?1", [id], |r| r.get(0))?;
        let mut q = db.prepare("SELECT data FROM merge_entries WHERE repository_id=?1 AND rowid<?2 AND state IN ('queued','waiting','ready') ORDER BY rowid")?;
        let rows = q
            .query_map(params![e["repositoryId"].as_i64(), rowid], |r| r.get::<_, String>(0))?
            .map(|r| Ok(serde_json::from_str::<Value>(&r?)?))
            .collect::<Result<Vec<_>>>()?;
        Ok(rows
            .into_iter()
            .filter(|o| o["kind"] != "revert" && o["headSha"].is_string() && o["headSha"] != e["headSha"] && o["batch"]["chain"].is_null())
            .map(|o| json!({"id":o["id"],"number":o["number"],"head":o["headSha"]}))
            .collect())
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

/// Whether `actor` may revert entry `id` (YN-18 S2d-2): the user, or a lead
/// of a Project the repository is linked to; the entry merged and its main
/// push CI went red; the user allows reverts here; none is under way.
fn revert_allowed(db: &Connection, actor: Option<&str>, id: &str) -> Result<Value> {
    let e = entry(db, id)?;
    let repository_id = e["repositoryId"].as_i64().unwrap_or(0);
    if let Some(agent) = actor {
        let lead: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_roles r JOIN project_agents p ON p.agent_id=r.agent_id AND p.project_id=r.project_id
             JOIN github_project_repos g ON g.project_id=r.project_id WHERE r.kind='lead' AND r.agent_id=?1 AND g.repo_id=?2)",
            params![agent, repository_id],
            |r| r.get(0),
        )?;
        ensure!(lead, "merge_revert_not_allowed: only a lead of a Project this repository is linked to, or the user, can revert a merge");
    }
    ensure!(
        e["kind"] != "revert" && e["state"] == "done" && e["reason"] == "main_red" && e["merge"]["sha"].is_string(),
        "merge_revert_not_allowed: only a merge whose main push CI went red can be reverted; entry {id} is {} ({})",
        e["state"].as_str().unwrap_or("?"),
        e["reason"].as_str().unwrap_or("no reason")
    );
    ensure!(
        repository(db, repository_id)?["revert"] == true,
        "merge_revert_not_allowed: reverts are off for {}; the user turns them on in Settings → Projects → its Project → Repositories",
        e["repository"].as_str().unwrap_or("?")
    );
    let busy: Option<String> = db
        .query_row(
            &format!("SELECT id FROM merge_entries WHERE json_extract(data,'$.revert.of')=?1 AND state IN {ACTIVE}"),
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(other) = busy {
        bail!("merge_revert_running: revert entry {other} of entry {id} is under way");
    }
    Ok(e)
}

/// A new revert entry for `original`, a merge whose main push CI went red
/// (YN-18 S2d-2). It holds no PR yet: its first check builds the revert on
/// `queue/revert-{entry}` and opens the PR, whose number it then takes.
fn revert_entry(db: &Connection, original: &Value, by: &TaskActor, source: &Value, reason: Option<&str>) -> Result<Value> {
    let id = uuid::Uuid::new_v4().to_string();
    let at = now();
    let m = &original["merge"];
    let e = json!({"id":id,"entryId":id,"kind":"revert","taskId":original["taskId"],"taskReference":original["taskReference"],
        "repositoryId":original["repositoryId"],"repository":original["repository"],"number":original["number"],"url":null,
        "linkId":null,"headSha":null,"baseBranch":original["baseBranch"],"mainAtRelease":m["sha"],"mainAnchoredAt":at,
        "requireWorkflows":[],"note":reason,
        "revert":{"of":original["id"],"pr":original["number"],"bad":m["sha"],"run":m["mainCi"]["run"]},
        "release":{"by":by,"requestId":null,"at":at,"source":source,"reviewId":null},
        "state":"queued","reason":null,"detail":"Core builds the revert first.","attempt":0,"checks":0,
        "waits":0,"readFailures":0,"waitingSince":null,"nextCheck":0,"evidence":null,"lastEvidence":null,"batch":null,"merge":null,
        "history":[{"at":at,"state":"queued","reason":null,"detail":"revert requested"}],"queueVersion":QUEUE_VERSION,"createdAt":at,"updatedAt":at});
    db.execute(
        "INSERT INTO merge_entries(id,task_id,repository_id,number,state,next_check,data) VALUES(?1,?2,?3,?4,'queued',0,?5)",
        params![id, original["taskId"].as_str(), original["repositoryId"].as_i64(), original["number"].as_i64(), e.to_string()],
    )?;
    collab::activity(db, original["taskId"].as_str().unwrap_or(""), "comment", by, source, json!({"mergeEntryId":id,
        "body":format!("Merge queue: revert of #{} (merge commit {}) requested by {} (entry {id}). Core builds it on its own branch, opens a PR, and merges it once CI on it is green, or at once if it restores a main whose CI was green.",
            original["number"], short(&m["sha"]), by.name)}))?;
    Ok(e)
}

/// Make the next chain step after entry `id` due now: the step ahead of it
/// merged, its post-check held, or it left the chain (YN-18 S2e).
fn next_chain_step(db: &Connection, id: &str) -> Result<()> {
    db.execute(
        "UPDATE merge_entries SET next_check=0,data=json_set(data,'$.nextCheck',0) WHERE json_extract(data,'$.batch.chain.prev')=?1 AND state IN ('queued','waiting','ready')",
        [id],
    )?;
    Ok(())
}

/// The chain's steps still to land, in order, ahead of entry `id` (YN-18 S2e).
/// Each one is built on the one before it: its base is that step's batch
/// commit, or, for the first, on a step that landed, or main. The walk ends
/// at `id` and at the first step that no longer follows, since every later
/// step stands on a base that left: those rebuild and join again.
fn chain_live(db: &Connection, chain: &Value, id: &str) -> Result<Vec<Value>> {
    let mut live: Vec<Value> = Vec::new();
    for step in chain["steps"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if step == id {
            break;
        }
        let Ok(s) = entry(db, step) else { break };
        let b = &s["batch"];
        let built = b["chain"]["id"] == chain["id"] && b["commit"].is_string() && b["cleanup"].is_null();
        let going = matches!(s["state"].as_str(), Some("queued" | "waiting" | "ready" | "merging")) || (s["state"] == "merged" && s["merge"]["post"].is_null());
        if !going {
            continue;
        }
        let follows = match live.last() {
            Some(p) => b["chain"]["prev"] == p["id"] && b["chain"]["base"] == p["batch"]["commit"],
            None => match b["chain"]["prev"].as_str() {
                None => true,
                Some(prev) => entry(db, prev).is_ok_and(|p| {
                    matches!(p["state"].as_str(), Some("merged" | "done")) && p["merge"]["post"]["ok"] == true && p["batch"]["commit"] == b["chain"]["base"]
                }),
            },
        };
        if !(built && follows) {
            break;
        }
        live.push(s);
    }
    Ok(live)
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
