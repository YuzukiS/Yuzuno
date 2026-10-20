use crate::commit_sha::{self, Form};
use crate::{collaboration_store as collaboration, model::now, store::Store};
use anyhow::{Context, Result, ensure};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    request_id: String,
    id: Option<String>,
    attempts: u8,
    next_try: i64,
    error: Option<String>,
}
impl Step {
    fn new(id: &str, round: usize, kind: &str) -> Self {
        Self {
            request_id: format!("delivery:{id}:{round}:{kind}"),
            id: None,
            attempts: 0,
            next_try: 0,
            error: None,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Round {
    number: usize,
    base_sha: String,
    head_sha: String,
    settings: Value,
    authorized_by: collaboration::TaskActor,
    authorized_at: String,
    result_id: Option<String>,
    review: Step,
    ci: Step,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Flow {
    id: String,
    task_id: String,
    task_ref: String,
    link_id: String,
    url: String,
    owner: collaboration::TaskActor,
    recipient: Option<collaboration::TaskActor>,
    dispatch_id: Option<String>,
    max_rounds: usize,
    enabled: bool,
    rounds: Vec<Round>,
    last_state: String,
    notified: Vec<String>,
    #[serde(default)]
    terminal: Option<Terminal>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Terminal {
    state: String,
    reason: String,
    at: String,
}
pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS delivery_flows(task_id TEXT PRIMARY KEY REFERENCES collaboration_tasks(id),data TEXT NOT NULL);")?;
    Ok(())
}
fn load(db: &Connection, task: &str) -> Result<Option<Flow>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT data FROM delivery_flows WHERE task_id=?1",
            [task],
            |r| r.get(0),
        )
        .optional()?;
    raw.map(|raw| Ok(serde_json::from_str(&raw)?)).transpose()
}
fn save(db: &Connection, f: &Flow) -> Result<()> {
    db.execute("INSERT INTO delivery_flows(task_id,data) VALUES(?1,?2) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data", params![f.task_id, serde_json::to_string(f)?])?;
    Ok(())
}
fn finish(db: &Connection, f: &mut Flow, state: &str, reason: &str) -> Result<()> {
    if f.terminal.is_none() {
        f.terminal = Some(Terminal {
            state: state.into(),
            reason: reason.into(),
            at: now(),
        });
    }
    f.enabled = false;
    save(db, f)?;
    crate::ci_monitor::lifecycle::close_delivery(
        db,
        &f.id,
        f.rounds.len(),
        &f.terminal.as_ref().unwrap().state,
    )
}
/// Called in the task/CI transaction and on worker recovery. Final outcomes are
/// durable: reopening a task or an older remote observation cannot undo them.
pub(crate) fn close_finished(db: &Connection, task_id: Option<&str>) -> Result<()> {
    let mut q = db.prepare("SELECT data FROM delivery_flows WHERE (?1 IS NULL OR task_id=?1) AND json_type(data,'$.terminal') IS NOT 'object'")?;
    let rows = q
        .query_map([task_id], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for raw in rows {
        let mut f: Flow = serde_json::from_str(&raw)?;
        let t = task(db, &f.task_id)?;
        let linked = link(db, &f)?;
        let ci = ci(db, f.rounds.last().unwrap())?;
        let merged = linked
            .as_ref()
            .is_some_and(|l| l["snapshot"]["merged"] == true || l["snapshot"]["state"] == "merged")
            || ci["watch"]["currentPr"]["merged"] == true
            || ci["watch"]["currentPr"]["state"] == "merged";
        let terminal = if !f.enabled {
            Some((
                "stopped",
                "Automatic delivery was explicitly stopped. Existing work and evidence are retained.",
            ))
        } else if merged {
            Some((
                "merged",
                "GitHub reports this PR merged. Candidate monitoring is closed; post-merge run verification remains independent.",
            ))
        } else if t.status == "done" {
            Some((
                "completed",
                "The task is done. Automatic delivery and its candidate monitoring are closed; evidence is retained.",
            ))
        } else if t.status == "cancelled" {
            Some((
                "cancelled",
                "The task was cancelled. Automatic delivery is closed; running reviews and remote CI are not cancelled.",
            ))
        } else if t.archived_at.is_some() {
            Some((
                "archived",
                "The task was archived. Automatic delivery is closed; evidence is retained.",
            ))
        } else {
            None
        };
        if let Some((state, reason)) = terminal {
            finish(db, &mut f, state, reason)?;
        }
    }
    Ok(())
}
fn task(db: &Connection, id: &str) -> Result<collaboration::SharedTask> {
    let raw: String = db.query_row(
        "SELECT data FROM collaboration_tasks WHERE id=?1",
        [id],
        |r| r.get(0),
    )?;
    Ok(serde_json::from_str(&raw)?)
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .with_context(|| format!("{key} is required"))
}
fn allowed(v: &Value, names: &[&str]) -> Result<()> {
    for key in v.as_object().context("Expected object")?.keys() {
        ensure!(
            names.contains(&key.as_str()),
            "Unknown delivery field: {key}"
        );
    }
    Ok(())
}
fn sha(v: &Value, key: &str) -> Result<String> {
    let s = text(v, key)?;
    ensure!(Form::GitHub.accepts(&s), "{}", commit_sha::problem(key, &s, Form::GitHub));
    Ok(s.to_ascii_lowercase())
}
fn link(db: &Connection, f: &Flow) -> Result<Option<Value>> {
    Ok(crate::github::store::task_links(db, &f.task_id)?
        .into_iter()
        .find(|l| l["id"] == f.link_id))
}
fn settings(db: &Connection) -> Result<Value> {
    Ok(serde_json::to_value(crate::pr_review::settings::read(db)?)?)
}
fn writable(task: &collaboration::SharedTask, actor: &collaboration::TaskActor) -> Result<()> {
    ensure!(
        task.archived_at.is_none() && !matches!(task.status.as_str(), "done" | "cancelled"),
        "Delivery requires an open task"
    );
    ensure!(
        actor.kind == "user"
            || task.assignee_agent_id.as_deref() == Some(&actor.id)
            || task
                .dispatch
                .as_ref()
                .is_some_and(|d| d.requested_by.id == actor.id),
        "Only the task owner, dispatcher or user can authorize this delivery"
    );
    Ok(())
}
pub(crate) fn call(
    store: &Store,
    db: &Connection,
    actor: &collaboration::TaskActor,
    source: &Value,
    op: &str,
    input: &Value,
) -> Result<Value> {
    let (id, seq) = collaboration::task_key(db, text(input, "taskId")?)?;
    if op == "delivery_get" {
        allowed(input, &["taskId"])?;
        return Ok(
            json!({"flow":load(db,&id)?.map(|f| view(db,&f)).transpose()?,"settings":settings(db)?}),
        );
    }
    let task = task(db, &id)?;
    if op == "delivery_stop" {
        allowed(input, &["requestId", "taskId", "flowId"])?;
        let mut f = load(db, &id)?.context("No enabled delivery")?;
        ensure!(input["flowId"] == f.id, "Delivery identity changed");
        ensure!(
            actor.kind == "user"
                || actor.id == f.owner.id
                || f.recipient.as_ref().is_some_and(|r| r.id == actor.id)
                || task.assignee_agent_id.as_deref() == Some(&actor.id)
                || task
                    .dispatch
                    .as_ref()
                    .is_some_and(|d| d.requested_by.id == actor.id),
            "Only the delivery owner, dispatcher or user can stop this delivery"
        );
        crate::ci_monitor::lifecycle::reconcile(db, Some(&id))?;
        f = load(db, &id)?.unwrap();
        finish(
            db,
            &mut f,
            "stopped",
            "Automatic delivery was explicitly stopped. Its CI interest is closed; manual interests, running reviews and remote CI are retained.",
        )?;
        return Ok(json!({"flow":view(db,&f)?}));
    }
    writable(&task, actor)?;
    crate::ci_monitor::lifecycle::reconcile(db, Some(&id))?;
    let old = load(db, &id)?;
    ensure!(
        matches!(op, "delivery_enable" | "delivery_continue"),
        "Unknown delivery operation"
    );
    let owner_id = task
        .assignee_agent_id
        .as_deref()
        .context("Assign this task to an Agent first")?;
    let agent = store
        .brief_in(db, owner_id)?
        .context("Task owner no longer exists")?
        .agent;
    ensure!(
        agent.closed_at.is_none() && agent.remote.is_none(),
        "Delivery needs an open local task owner"
    );
    let linked = crate::github::store::task_links(db, &id)?
        .into_iter()
        .find(|l| l["id"] == input["linkId"] && l["kind"] == "pull")
        .context("Choose a linked PR")?;
    let base = sha(input, "baseSha")?;
    let head = sha(input, "headSha")?;
    ensure!(
        linked["error"].is_null()
            && linked["stale"] == false
            && linked["snapshot"]["baseSha"] == base
            && linked["snapshot"]["headSha"] == head,
        "Refresh the linked PR; the candidate must match its current base and head"
    );
    let config = settings(db)?;
    ensure!(
        input["settings"] == config,
        "Workspace review settings changed; read delivery_get and authorize the actual settings"
    );
    let mut f = if op == "delivery_enable" {
        allowed(
            input,
            &[
                "requestId",
                "taskId",
                "linkId",
                "baseSha",
                "headSha",
                "settings",
                "maxRounds",
            ],
        )?;
        ensure!(
            old.is_none(),
            "This task already has a delivery; continue it explicitly within its original limit"
        );
        let max = input["maxRounds"]
            .as_u64()
            .filter(|n| (1..=2).contains(n))
            .context("maxRounds must be 1 or 2")?;
        Flow {
            id: uuid::Uuid::new_v4().to_string(),
            task_id: id.clone(),
            task_ref: format!("T-{seq}"),
            link_id: text(input, "linkId")?.into(),
            url: text(&linked, "url")?.into(),
            owner: collaboration::agent_actor(store, db, owner_id)?,
            recipient: task
                .dispatch
                .as_ref()
                .and_then(|d| d.notification_recipient.clone()),
            dispatch_id: task.dispatch.as_ref().map(|d| d.id.clone()),
            max_rounds: max as usize,
            enabled: true,
            rounds: vec![],
            last_state: String::new(),
            notified: vec![],
            terminal: None,
        }
    } else {
        allowed(
            input,
            &[
                "requestId",
                "taskId",
                "flowId",
                "expectedRound",
                "linkId",
                "baseSha",
                "headSha",
                "settings",
            ],
        )?;
        let f = old.context("Enable this delivery first")?;
        ensure!(
            f.terminal.is_none(),
            "This delivery is terminal; retained evidence and the original review cap cannot be reset"
        );
        ensure!(
            input["flowId"] == f.id
                && input["expectedRound"] == f.rounds.len()
                && input["linkId"] == f.link_id,
            "Delivery identity or round changed; reread before continuing"
        );
        ensure!(
            f.rounds.len() < f.max_rounds,
            "Authorized review limit reached; human judgment is required"
        );
        ensure!(
            f.owner.id == owner_id && f.dispatch_id == task.dispatch.as_ref().map(|d| d.id.clone()),
            "Task assignment changed; reconcile this delivery manually"
        );
        let r = f.rounds.last().unwrap();
        let review = review(db, r.review.id.as_deref())?;
        ensure!(
            review.as_ref().is_some_and(|v| !matches!(
                v["status"].as_str(),
                Some("preparing" | "running" | "unknown")
            )),
            "Reconcile the existing review first; an unfinished or unknown review cannot be replaced"
        );
        f
    };
    let number = f.rounds.len() + 1;
    let r = Round {
        number,
        base_sha: base,
        head_sha: head,
        settings: config,
        authorized_by: actor.clone(),
        authorized_at: now(),
        result_id: None,
        review: Step::new(&f.id, number, "review"),
        ci: Step::new(&f.id, number, "ci"),
    };
    f.rounds.push(r);
    f.enabled = true;
    // Enabling around a manual review adopts its identity, including unknown.
    // Continuing deliberately authorizes a NEW attempt, even for the same SHA.
    if op == "delivery_enable" {
        let r = f.rounds.last_mut().unwrap();
        let raw:Option<String>=db.query_row("SELECT data FROM pr_reviews WHERE task_id=?1 AND link_id=?2 AND COALESCE(json_extract(data,'$.requestedBaseSha'),json_extract(data,'$.baseSha'))=?3 AND COALESCE(json_extract(data,'$.requestedHeadSha'),json_extract(data,'$.headSha'))=?4 AND json_extract(data,'$.requestedHarness')=?5 AND json_extract(data,'$.requestedModel')=?6 ORDER BY rowid DESC LIMIT 1",params![id,f.link_id,r.base_sha,r.head_sha,r.settings["harness"].as_str(),r.settings["model"].as_str()],|row|row.get(0)).optional()?;
        if let Some(raw) = raw {
            r.review.id = Some(text(&serde_json::from_str::<Value>(&raw)?, "id")?.into());
        }
        let unresolved: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM pr_reviews WHERE task_id=?1 AND link_id=?2 AND status IN ('preparing','running','unknown') AND id IS NOT ?3)", params![id,f.link_id,r.review.id], |row|row.get(0))?;
        ensure!(
            !unresolved,
            "Another review is running or its outcome is unknown; reconcile that retained review before enabling delivery"
        );
    }
    save(db, &f)?;
    collaboration::activity(
        db,
        &id,
        "comment",
        actor,
        source,
        json!({"body":format!("Delivery {} authorized: round {number}/{}, fixed {} → {}. Matching result submission starts review and CI; no automatic merge or release.",f.id,f.max_rounds,f.rounds[number-1].base_sha,f.rounds[number-1].head_sha),"deliveryId":f.id}),
    )?;
    Ok(json!({"flow":view(db,&f)?}))
}
/// Called in the result transaction, before its receipt commits.
pub(crate) fn submitted(
    db: &Connection,
    task: &collaboration::SharedTask,
    actor: &collaboration::TaskActor,
    input: &Value,
) -> Result<()> {
    let Some(candidate) = input.get("delivery") else {
        return Ok(());
    };
    allowed(candidate, &["flowId", "round", "baseSha", "headSha"])?;
    let mut f = load(db, &task.id)?.context("Enable the delivery before submitting it")?;
    ensure!(f.enabled, "This delivery is stopped");
    ensure!(
        actor.kind == "user" || actor.id == f.owner.id,
        "Only the owner or user can submit this delivery"
    );
    ensure!(
        task.assignee_agent_id.as_deref() == Some(&f.owner.id)
            && f.dispatch_id == task.dispatch.as_ref().map(|d| d.id.clone()),
        "Delivery assignment changed"
    );
    ensure!(
        task.status == "review",
        "Submit an automated delivery for review, not done"
    );
    let r = f.rounds.last_mut().unwrap();
    ensure!(
        candidate["flowId"] == f.id
            && candidate["round"] == r.number
            && candidate["baseSha"] == r.base_sha
            && candidate["headSha"] == r.head_sha,
        "Result does not match the authorized delivery candidate"
    );
    ensure!(
        r.result_id.is_none(),
        "This delivery round already has a result; read delivery_get rather than resubmitting"
    );
    r.result_id = Some(text(task.result.as_ref().unwrap(), "id")?.into());
    save(db, &f)
}
fn review(db: &Connection, id: Option<&str>) -> Result<Option<Value>> {
    let Some(id) = id else { return Ok(None) };
    let raw: Option<String> = db
        .query_row("SELECT data FROM pr_reviews WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|s| Ok(serde_json::from_str(&s)?)).transpose()
}
/// Both native manual requests and automation enter this same transaction.
/// A registered candidate returns its original attempt even after restart.
pub(crate) fn registered_review(
    db: &Connection,
    task: &str,
    link_id: &str,
    base: Option<&str>,
    head: Option<&str>,
) -> Result<Option<Value>> {
    let Some(f) = matching(db, task, link_id, base, head)? else {
        return Ok(None);
    };
    review(db, f.rounds.last().unwrap().review.id.as_deref())
}
fn matching(
    db: &Connection,
    task: &str,
    link_id: &str,
    base: Option<&str>,
    head: Option<&str>,
) -> Result<Option<Flow>> {
    let Some(f) = load(db, task)? else {
        return Ok(None);
    };
    if f.link_id != link_id {
        return Ok(None);
    };
    let linked = link(db, &f)?.unwrap_or(Value::Null);
    let r = f.rounds.last().unwrap();
    if base.or(linked["snapshot"]["baseSha"].as_str()) == Some(&r.base_sha)
        && head.or(linked["snapshot"]["headSha"].as_str()) == Some(&r.head_sha)
    {
        Ok(Some(f))
    } else {
        Ok(None)
    }
}
pub(crate) fn attach_review(
    db: &Connection,
    task: &str,
    link_id: &str,
    base: Option<&str>,
    head: Option<&str>,
    config: &Value,
    request_id: &str,
    id: &str,
) -> Result<()> {
    let Some(mut f) = matching(db, task, link_id, base, head)? else {
        return Ok(());
    };
    ensure!(
        f.enabled,
        "Delivery stopped; no new registered review may start"
    );
    let current = self::task(db, task)?;
    let r = f.rounds.last_mut().unwrap();
    if request_id == r.review.request_id {
        ensure!(
            r.result_id.is_some()
                && current.archived_at.is_none()
                && !matches!(current.status.as_str(), "done" | "cancelled")
                && current.assignee_agent_id.as_deref() == Some(&f.owner.id)
                && f.dispatch_id == current.dispatch.as_ref().map(|d| d.id.clone()),
            "Delivery authorization changed before review launch"
        );
    }
    ensure!(
        &r.settings == config,
        "Authorized review settings changed; do not start a different reviewer"
    );
    ensure!(r.review.id.is_none(), "Registered review already exists");
    r.review.id = Some(id.into());
    save(db, &f)
}

fn ci(db: &Connection, r: &Round) -> Result<Value> {
    let Some(id) = r.ci.id.as_deref() else {
        return Ok(Value::Null);
    };
    let sub: Option<(String, bool, i64)> = db
        .query_row(
            "SELECT watch_id,active,expires FROM ci_subscriptions WHERE id=?1",
            [id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((wid, active, expires)) = sub else {
        return Ok(Value::Null);
    };
    let raw: String = db.query_row("SELECT data FROM ci_watches WHERE id=?1", [&wid], |row| {
        row.get(0)
    })?;
    let w: Value = serde_json::from_str(&raw)?;
    let mut query=db.prepare("SELECT r.data FROM ci_watch_runs wr JOIN ci_runs r ON r.id=wr.run_id WHERE wr.watch_id=?1 ORDER BY r.seq DESC")?;
    let rows = query
        .query_map([wid], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    // Runs can be retried or started again for one SHA. Use the latest run and
    // attempt per workflow/event, not an old success or a superseded failure.
    let mut latest = std::collections::BTreeMap::<String, Value>::new();
    for raw in rows {
        let run: Value = serde_json::from_str(&raw)?;
        let key = format!("{}:{}", run["workflowId"], run["event"]);
        let order = |v: &Value| {
            (
                v["runId"]
                    .as_str()
                    .and_then(|n| n.parse::<u64>().ok())
                    .unwrap_or(0),
                v["attempt"]
                    .as_str()
                    .and_then(|n| n.parse::<u64>().ok())
                    .unwrap_or(0),
            )
        };
        if latest.get(&key).is_none_or(|old| order(&run) > order(old)) {
            latest.insert(key, run);
        }
    }
    Ok(
        json!({"subscriptionId":id,"active":active && expires>chrono::Utc::now().timestamp(),"watch":w,"runs":latest.into_values().collect::<Vec<_>>()}),
    )
}
fn state(db: &Connection, f: &Flow, rv: &Value, ci: &Value) -> Result<(&'static str, String)> {
    let r = f.rounds.last().unwrap();
    let state = |s, reason: &str| Ok((s, reason.to_owned()));
    if let Some(t) = &f.terminal {
        let label = match t.state.as_str() {
            "completed" => "completed",
            "cancelled" => "cancelled",
            "archived" => "archived",
            "merged" => "merged",
            _ => "stopped",
        };
        return state(label, &t.reason);
    }
    if !f.enabled {
        return state(
            "stopped",
            "Automatic delivery is stopped. Existing operations and evidence are retained.",
        );
    }
    let task = task(db, &f.task_id)?;
    if task.archived_at.is_some()
        || matches!(task.status.as_str(), "done" | "cancelled")
        || task.assignee_agent_id.as_deref() != Some(&f.owner.id)
        || f.dispatch_id != task.dispatch.as_ref().map(|d| d.id.clone())
    {
        return state(
            "needs_judgment",
            "The task or assignment changed; reconcile delivery before continuing.",
        );
    }
    let Some(linked) = link(db, f)? else {
        return state("needs_judgment", "The PR is no longer linked to this task.");
    };
    let w = &ci["watch"];
    // Prefer whichever source actually observed the PR more recently. A known
    // changed revision invalidates readiness even when the other cache is old.
    let snapshot = &linked["snapshot"];
    let newer_link =
        linked["syncedAt"].as_str().unwrap_or("") > w["observedAt"].as_str().unwrap_or("");
    let (base, head, pr_state, merged) = if newer_link || w["currentPr"].is_null() {
        (
            &snapshot["baseSha"],
            &snapshot["headSha"],
            &snapshot["state"],
            &snapshot["merged"],
        )
    } else {
        (
            &w["currentPr"]["baseSha"],
            &w["currentHeadSha"],
            &w["currentPr"]["state"],
            &w["currentPr"]["merged"],
        )
    };
    if merged == true || pr_state == "merged" {
        return state(
            "merged",
            "GitHub reports this PR merged. Deployment is not tracked by this flow.",
        );
    }
    if pr_state == "closed" {
        return state(
            "needs_judgment",
            "GitHub reports this PR closed; no automatic continuation.",
        );
    }
    if base != &json!(r.base_sha)
        || head != &json!(r.head_sha)
        || (w["currentHeadSha"].is_string() && w["currentHeadSha"] != r.head_sha)
        || (w["currentPr"]["baseSha"].is_string() && w["currentPr"]["baseSha"] != r.base_sha)
    {
        return state(
            "candidate_changed",
            "The PR revision changed. Old evidence cannot approve it; explicitly continue with its new fixed revision.",
        );
    }
    if r.result_id.is_none() {
        return state(
            "awaiting_result",
            "Submit a task result with this exact delivery candidate to start review and CI.",
        );
    }
    for (name, step) in [("Review", &r.review), ("CI subscription", &r.ci)] {
        if step.id.is_none() && step.attempts >= 3 {
            return Ok((
                "infrastructure_error",
                format!(
                    "{name} setup failed after three attempts with the same request ID. Reconcile the retained operation; no replacement review is started. {}",
                    step.error
                        .as_deref()
                        .unwrap_or("Completion was not confirmed.")
                ),
            ));
        }
    }
    if rv.is_null() {
        return state(
            "waiting_review",
            "Starting the registered independent review.",
        );
    }
    if matches!(rv["status"].as_str(), Some("preparing" | "running")) {
        return state(
            "waiting_review",
            "The independent reviewer is working on this fixed revision.",
        );
    }
    if rv["status"] != "completed" {
        return Ok((
            "infrastructure_error",
            format!(
                "Review {}: {}. Keep its original review/request IDs and reconcile manually; it will not be restarted automatically.",
                rv["status"].as_str().unwrap_or("unknown"),
                rv["error"].as_str().unwrap_or("No confirmed completion")
            ),
        ));
    }
    if rv["baseSha"] != r.base_sha
        || rv["headSha"] != r.head_sha
        || rv["requestedHarness"] != r.settings["harness"]
        || rv["requestedModel"] != r.settings["model"]
        || rv["actualHarness"] != r.settings["harness"]
        || !reviewed_by_requested_model(rv, &r.settings)
    {
        return state(
            "needs_judgment",
            "The completed reviewer identity or revision does not match the authorized candidate.",
        );
    }
    if rv["conclusion"] == "changes_requested" {
        return if f.rounds.len() >= f.max_rounds {
            state(
                "needs_judgment",
                "Review requested changes and the authorized review limit is exhausted.",
            )
        } else {
            state(
                "waiting_fix",
                "The reviewer requested changes. The owner must fix and explicitly continue; push alone starts nothing.",
            )
        };
    }
    if !crate::pr_review::policy::passes(rv) {
        return state(
            "needs_judgment",
            "The review did not produce an explicit passing conclusion.",
        );
    }
    if ci.is_null() {
        return state(
            "waiting_ci",
            "Review passed. Waiting for the exact-commit CI subscription.",
        );
    }
    if ci["active"] != true || !w["error"].is_null() || w["truncated"] == true {
        return state(
            "infrastructure_error",
            "CI is inactive, incomplete or could not be read. The previous green result is not approval.",
        );
    }
    let fresh = w["observedAt"]
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|t| chrono::Utc::now().signed_duration_since(t).num_seconds() < 600);
    if !fresh {
        return state(
            "waiting_ci",
            "Review passed. Waiting for a recent CI observation (less than ten minutes old).",
        );
    }
    if w["currentHeadSha"] != r.head_sha || w["currentPr"]["baseSha"] != r.base_sha {
        return state(
            "candidate_changed",
            "CI observed a different PR revision; explicitly authorize its next candidate.",
        );
    }
    let runs = ci["runs"].as_array().unwrap();
    if runs.is_empty() {
        return state(
            "waiting_ci",
            "No GitHub Actions run has been observed for this exact commit yet.",
        );
    }
    if runs
        .iter()
        .any(|r| r["workflowId"].is_null() || r["rawStatus"].is_null())
    {
        return state(
            "needs_judgment",
            "CI workflow identity is incomplete; refresh CI before judging this candidate.",
        );
    }
    if runs.iter().any(|r| r["rawStatus"] != "completed") {
        return state(
            "waiting_ci",
            "Waiting for the latest observed workflow attempts to finish.",
        );
    }
    if runs.iter().any(|r| {
        !matches!(
            r["conclusion"].as_str(),
            Some("success" | "neutral" | "skipped")
        )
    }) {
        return state(
            "ci_failed",
            "One or more latest workflow attempts did not pass. Inspect CI evidence before continuing.",
        );
    }
    state(
        "ready_to_merge",
        "Review passed and the latest observed GitHub Actions attempts passed for this fixed revision. A person must check merge requirements and merge; nothing is deployed.",
    )
}
/// Claude reports the full model id an alias such as `opus[1m]` resolved to.
/// That id counts only when this same review record holds it as
/// `resolvedModel`: the Claude reviewer reads it from the native catalog row
/// whose value is exactly the requested model, in the review's own process,
/// before the prompt is sent. Missing, empty or non-Claude resolutions never
/// match, and Codex keeps the exact requested model.
fn reviewed_by_requested_model(rv: &Value, settings: &Value) -> bool {
    rv["actualModel"] == settings["model"]
        || (settings["harness"] == "claude"
            && rv["requestedHarness"] == "claude"
            && rv["actualHarness"] == "claude"
            && rv["resolvedModel"]
                .as_str()
                .is_some_and(|m| !m.trim().is_empty() && rv["actualModel"] == m))
}
fn view(db: &Connection, f: &Flow) -> Result<Value> {
    let r = f.rounds.last().unwrap();
    let rv = review(db, r.review.id.as_deref())?.unwrap_or(Value::Null);
    let ci = ci(db, r)?;
    let (state, reason) = state(db, f, &rv, &ci)?;
    let mut v = serde_json::to_value(f)?;
    v["taskId"] = json!(f.task_ref);
    v["state"] = json!(state);
    v["reason"] = json!(reason);
    v["candidate"] =
        json!({"flowId":f.id,"round":r.number,"baseSha":r.base_sha,"headSha":r.head_sha});
    v["reviewEvidence"] = if rv.is_null() {
        Value::Null
    } else {
        json!({"id":rv["id"],"status":rv["status"],"conclusion":rv["conclusion"],"error":rv["error"],"actualModel":rv["actualModel"],"actualHarness":rv["actualHarness"],"finishedAt":rv["finishedAt"],"baseSha":rv["baseSha"],"headSha":rv["headSha"]})
    };
    v["ciEvidence"] = ci;
    Ok(v)
}
pub(super) struct Plan {
    pub owner: String,
    pub input: Value,
    kind: &'static str,
    round: usize,
}
impl Store {
    pub(super) fn delivery_tasks(&self) -> Result<Vec<String>> {
        let db = self.db.read()?;
        let mut q = db
            .prepare("SELECT task_id FROM delivery_flows WHERE json_extract(data,'$.enabled')=1 OR json_extract(data,'$.lastState') IS NOT json_extract(data,'$.terminal.state')")?;
        let tasks = q
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(tasks)
    }
    pub(super) fn delivery_claim(&self, task_id: &str, kind: &'static str) -> Result<Option<Plan>> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        crate::ci_monitor::lifecycle::reconcile(&tx, Some(task_id))?;
        let mut f = load(&tx, task_id)?.context("Delivery missing")?;
        // Reconcile a CI subscription that committed before a reply was lost.
        let r = f.rounds.last_mut().unwrap();
        if r.ci.id.is_none() {
            let raw:Option<String>=tx.query_row("SELECT response_json FROM collaboration_requests WHERE actor=?1 AND operation='ci_subscribe' AND request_id=?2",params![format!("agent:{}",f.owner.id),r.ci.request_id],|row|row.get(0)).optional()?;
            if let Some(raw) = raw {
                r.ci.id =
                    Some(text(&serde_json::from_str::<Value>(&raw)?, "subscriptionId")?.into());
                save(&tx, &f)?;
            }
        }
        let status = view(&tx, &f)?;
        let r = f.rounds.last().unwrap();
        if !f.enabled
            || r.result_id.is_none()
            || matches!(
                status["state"].as_str(),
                Some("candidate_changed" | "needs_judgment" | "merged")
            )
        {
            tx.commit()?;
            return Ok(None);
        }
        if kind == "review" && settings(&tx)? != r.settings && r.review.id.is_none() {
            let r = f.rounds.last_mut().unwrap();
            r.review.attempts = 3;
            r.review.error = Some("Workspace review settings changed after authorization.".into());
            save(&tx, &f)?;
            tx.commit()?;
            return Ok(None);
        }
        let stamp = chrono::Utc::now().timestamp();
        let r = f.rounds.last_mut().unwrap();
        let step = if kind == "review" {
            &mut r.review
        } else {
            &mut r.ci
        };
        if step.id.is_some() || step.attempts >= 3 || step.next_try > stamp {
            tx.commit()?;
            return Ok(None);
        }
        step.attempts += 1;
        step.next_try = stamp + 30;
        let input = if kind == "review" {
            json!({"requestId":step.request_id,"taskId":f.task_ref,"linkId":f.link_id,"baseSha":r.base_sha,"headSha":r.head_sha})
        } else {
            json!({"requestId":step.request_id,"taskId":f.task_ref,"url":f.url,"expectedSha":r.head_sha})
        };
        let plan = Plan {
            owner: f.owner.id.clone(),
            input,
            kind,
            round: r.number,
        };
        save(&tx, &f)?;
        tx.commit()?;
        Ok(Some(plan))
    }
    pub(super) fn delivery_finish(
        &self,
        task_id: &str,
        plan: &Plan,
        answer: std::result::Result<Value, String>,
    ) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let mut f = load(&tx, task_id)?.context("Delivery missing")?;
        let r = &mut f.rounds[plan.round - 1];
        let step = if plan.kind == "review" {
            &mut r.review
        } else {
            &mut r.ci
        };
        match answer {
            Ok(value) => {
                step.id = Some(text(&value, "id")?.into());
                step.error = None;
            }
            Err(error) => step.error = Some(error),
        }
        save(&tx, &f)?;
        crate::ci_monitor::lifecycle::reconcile(&tx, Some(task_id))?;
        tx.commit()?;
        Ok(())
    }
    pub(super) fn delivery_reconcile(&self, task_id: &str) -> Result<bool> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        crate::ci_monitor::lifecycle::reconcile(&tx, Some(task_id))?;
        let mut f = load(&tx, task_id)?.context("Delivery missing")?;
        let v = view(&tx, &f)?;
        let current = text(&v, "state")?;
        if f.last_state == current {
            tx.commit()?;
            return Ok(false);
        }
        f.last_state = current.into();
        let round = f.rounds.len();
        let key = format!("{round}:{current}");
        if matches!(
            current,
            "waiting_fix"
                | "ci_failed"
                | "ready_to_merge"
                | "needs_judgment"
                | "infrastructure_error"
                | "candidate_changed"
                | "merged"
                | "completed"
                | "cancelled"
                | "archived"
                | "stopped"
        ) && !f.notified.contains(&key)
        {
            f.notified.push(key);
            let mut recipients = vec![f.owner.clone()];
            if let Some(recipient) = &f.recipient {
                if recipient.id != f.owner.id {
                    recipients.push(recipient.clone());
                }
            }
            for recipient in recipients {
                let id = uuid::Uuid::new_v4().to_string();
                collaboration::insert_message(
                    &tx,
                    json!({"id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},"recipient":recipient,"body":format!("{} delivery round {round}/{}: {current}. {} PR {}. Read delivery_get(taskId={}) for fixed revision, review and CI evidence. This message does not authorize another paid review, merge or deployment.",f.task_ref,f.max_rounds,v["reason"].as_str().unwrap_or(""),f.url,f.task_ref),"taskId":f.task_id,"replyTo":null,"threadId":id,"createdAt":now(),"source":{"deliveryId":f.id},"priority":"normal","metadata":{"kind":"delivery","name":f.task_ref,"status":current,"deliveryId":f.id,"round":round}}),
                )?;
            }
        }
        save(&tx, &f)?;
        tx.commit()?;
        Ok(true)
    }
}
