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
    /// A review start this round authorized was refused by the PR's started
    /// round limit. It is not retried: a person decides what happens next.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    limit_refused: Option<String>,
    /// How many of its `attempts` setup calls have ended (YN-12 S4): only
    /// when all three have is its setup proven to have failed. None on a
    /// step an older Core wrote, which can't prove that.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    finished: Option<u8>,
}
impl Step {
    fn new(id: &str, round: usize, kind: &str) -> Self {
        Self {
            request_id: format!("delivery:{id}:{round}:{kind}"),
            id: None,
            attempts: 0,
            next_try: 0,
            error: None,
            limit_refused: None,
            finished: Some(0),
        }
    }
    /// The review of a round's attempt `n`; the first keeps the round's
    /// original request ID, so a flow an older Core started reads the same.
    fn review(id: &str, round: usize, n: usize) -> Self {
        let mut step = Self::new(id, round, "review");
        if n > 1 {
            step.request_id = format!("{}:{n}", step.request_id);
        }
        step
    }
    /// Its setup is proven to have failed: all three tries ended without an
    /// operation, and none was refused by the PR's started round limit.
    fn exhausted(&self) -> bool {
        self.id.is_none()
            && self.limit_refused.is_none()
            && self.attempts >= 3
            && self.finished.is_some_and(|done| done >= self.attempts)
    }
}
/// A round's paid review attempts at its one head, the same as the three
/// setup tries each gets (YN-12 S4, and mod.rs).
const MAX_ATTEMPTS: usize = 3;
/// One attempt a round moved past: a paid review of one fixed base and head,
/// or its setup, that reached no verdict and doesn't count (YN-12 S4).
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Attempt {
    number: usize,
    base_sha: String,
    review: Step,
    result_id: Option<String>,
    authorized_by: collaboration::TaskActor,
    authorized_at: String,
    /// `uncounted_failure` or `setup_exhausted`.
    replaced: String,
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
    /// One per round, whichever attempt its review is at.
    ci: Step,
    /// The attempts at this head before the current one, oldest first.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    earlier: Vec<Attempt>,
}
impl Round {
    /// The current attempt's number.
    fn attempt(&self) -> usize {
        self.earlier.len() + 1
    }
    /// This Core wrote its current attempt: its mail and view name the
    /// attempt. A round an older Core wrote and nobody retried reads as before.
    fn names_attempts(&self) -> bool {
        self.review.finished.is_some()
    }
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
    /// The attempt and state last reconciled, `{round}[.{attempt}]:{state}`
    /// (YN-12 S4). None where it is `{round}:{lastState}`, as older Cores
    /// wrote it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_key: Option<String>,
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
/// Reads a flow and saves it unchanged, as any write of an older flow does.
#[cfg(test)]
pub(super) fn resave(db: &Connection, task: &str) -> Result<()> {
    save(db, &load(db, task)?.context("Delivery missing")?)
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
/// The reviewer a new review of `task` would get (T-190: its project's, the
/// Workspace's or the built-in one), as a delivery authorizes it.
fn settings(db: &Connection, task: &str) -> Result<Value> {
    Ok(serde_json::to_value(crate::pr_review::settings::for_task(db, task)?)?)
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
    let (id, _) = collaboration::task_key(db, text(input, "taskId")?)?;
    let reference = collaboration::task_number(db, &id)?;
    if op == "delivery_get" {
        allowed(input, &["taskId"])?;
        return Ok(
            json!({"flow":load(db,&id)?.map(|f| view(db,&f)).transpose()?,"settings":settings(db, &id)?}),
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
        agent.closed_at.is_none(),
        "Delivery needs an open task owner"
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
    let config = settings(db, &id)?;
    ensure!(
        input["settings"] == config,
        "The review settings for this task changed; read delivery_get and authorize the actual settings"
    );
    // Why the last round's current attempt is replaced, when this continues
    // its head as another attempt rather than as the next round.
    let mut retry = None;
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
            task_ref: reference,
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
            last_key: None,
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
            f.owner.id == owner_id && f.dispatch_id == task.dispatch.as_ref().map(|d| d.id.clone()),
            "Task assignment changed; reconcile this delivery manually"
        );
        retry = continued(db, &f, &linked, &head)?;
        f
    };
    if let Some(replaced) = retry {
        // Another attempt at the last round's head: the attempt it replaces
        // is kept whole in `earlier`; the round's CI stays as it is.
        let flow = f.id.clone();
        let r = f.rounds.last_mut().unwrap();
        let (round, number) = (r.number, r.attempt());
        let attempt = Attempt {
            number,
            base_sha: std::mem::replace(&mut r.base_sha, base),
            review: std::mem::replace(&mut r.review, Step::review(&flow, round, number + 1)),
            result_id: r.result_id.take(),
            authorized_by: std::mem::replace(&mut r.authorized_by, actor.clone()),
            authorized_at: std::mem::replace(&mut r.authorized_at, now()),
            replaced: replaced.into(),
        };
        r.earlier.push(attempt);
        r.settings = config;
    } else {
        let number = f.rounds.len() + 1;
        let r = Round {
            number,
            base_sha: base,
            head_sha: head,
            settings: config,
            authorized_by: actor.clone(),
            authorized_at: now(),
            result_id: None,
            review: Step::review(&f.id, number, 1),
            ci: Step::new(&f.id, number, "ci"),
            earlier: vec![],
        };
        f.rounds.push(r);
    }
    f.enabled = true;
    // Enabling around a manual review adopts its identity, including unknown.
    // Continuing authorizes a new round for a new head, or another attempt
    // at the same head only after its attempt reached no verdict (continued).
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
    // A delivery round also uses one of the PR's started rounds (YN-12 S1).
    // This is a precheck, never a reservation: the atomic check stays in
    // create_pr_review, and a round that loses the race records limitRefused
    // there rather than retrying.
    if f.rounds.last().is_some_and(|r| r.review.id.is_none()) {
        let (started, uncounted) = crate::pr_review::store::started_rounds(db, &linked)?;
        ensure!(
            started < crate::pr_review::store::MAX_STARTED_ROUNDS,
            "{} No delivery round was authorized.",
            crate::pr_review::store::round_limit_refusal(started, uncounted, "a delivery round")
        );
    }
    save(db, &f)?;
    let r = f.rounds.last().unwrap();
    let body = match r.earlier.last().filter(|_| retry.is_some()) {
        Some(before) => format!(
            "Delivery {} authorized attempt {} of round {}/{} at {} → {}: attempt {} ({}) reached no verdict and doesn't count. A matching result submission starts the review; no automatic merge or release.",
            f.id, r.attempt(), r.number, f.max_rounds, r.base_sha, r.head_sha, before.number,
            before.review.id.as_deref().unwrap_or("setup")
        ),
        None => format!(
            "Delivery {} authorized: round {}/{}, fixed {} → {}. Matching result submission starts review and CI; no automatic merge or release.",
            f.id, r.number, f.max_rounds, r.base_sha, r.head_sha
        ),
    };
    collaboration::activity(db, &id, "comment", actor, source, json!({"body":body,"deliveryId":f.id}))?;
    Ok(json!({"flow":view(db,&f)?}))
}

/// What `delivery_continue` may authorize for `head` after the last round
/// (YN-12 S4): a round is one head, an attempt one paid review of a fixed
/// base and head. Some(why the current attempt is replaced) for another
/// attempt at the round's head, None for the next round, or the refusal.
/// A head with a counted review of this PR, by this flow or anyone else, is
/// never reviewed again here, and a base-only change adds nothing.
fn continued(db: &Connection, f: &Flow, linked: &Value, head: &str) -> Result<Option<&'static str>> {
    let r = f.rounds.last().unwrap();
    let (round, attempt) = (r.number, r.attempt());
    ensure!(
        r.review.id.is_some() || r.review.limit_refused.is_none(),
        "Round {round} attempt {attempt} was refused by this PR's two started review rounds before it started. Only whoever decides can go beyond that limit, by starting a round themselves. No attempt was authorized."
    );
    // The current attempt must have ended with what it ended with known.
    let (current, replaced) = match r.review.id.as_deref() {
        Some(id) => {
            let rv = review(db, Some(id))?;
            let rv = rv
                .filter(|v| !matches!(v["status"].as_str(), Some("preparing" | "running" | "unknown")))
                .context("Reconcile the existing review first; an unfinished or unknown review cannot be replaced")?;
            let status = rv["status"].as_str().unwrap_or("unknown").to_owned();
            // A completed review without an explicit conclusion is an unknown
            // outcome too: a person judges it before any round or attempt
            // replaces it (Lead 11659). A failed or cancelled one keeps its path.
            ensure!(
                status != "completed"
                    || matches!(rv["conclusion"].as_str(), Some("no_findings" | "approved_with_notes" | "changes_requested")),
                "Reconcile the existing review first: review {id} completed without an explicit conclusion ({}), and an unknown outcome cannot be replaced by another round or attempt. No attempt was authorized.",
                rv["conclusion"].as_str().unwrap_or("none recorded")
            );
            let uncounted = status == "failed" && !crate::pr_review::store::counts_toward_limit(db, id)?;
            (Some((id.to_owned(), status)), uncounted.then_some("uncounted_failure"))
        }
        None => {
            ensure!(
                r.review.attempts > 0,
                "Reconcile the existing review first; an unfinished or unknown review cannot be replaced"
            );
            let receipt: bool = db.query_row(
                "SELECT EXISTS(SELECT 1 FROM collaboration_requests WHERE actor=?1 AND operation='review_start' AND request_id=?2)",
                params![format!("agent:{}", f.owner.id), r.review.request_id],
                |row| row.get(0),
            )?;
            ensure!(
                r.review.exhausted() && !receipt,
                "Round {round} attempt {attempt} hasn't been confirmed to have ended: its setup is in flight or wasn't recorded as finished. Reconcile it first. No attempt was authorized."
            );
            (None, Some("setup_exhausted"))
        }
    };
    let counted = |(id, status): (String, String)| {
        anyhow::anyhow!(
            "Head {head} already has a counted review of this PR ({id}, {status}); a head gets one counted round, and a base-only change doesn't add one. Push a fix and continue with its new head, or ask whoever decides. No attempt was authorized."
        )
    };
    if let Some(found) = crate::pr_review::store::counted_at_head(db, linked["repositoryId"].as_i64(), linked["number"].as_i64(), head)? {
        return Err(counted(found));
    }
    if r.head_sha != head {
        ensure!(
            f.rounds.len() < f.max_rounds,
            "Authorized review limit reached; human judgment is required"
        );
        return Ok(None);
    }
    ensure!(
        attempt < MAX_ATTEMPTS,
        "Round {round} already had {MAX_ATTEMPTS} attempts; human judgment is required. No attempt was authorized."
    );
    // Not replaced: its review counts, although no head recorded on it
    // placed it in the head's history.
    match replaced {
        Some(replaced) => Ok(Some(replaced)),
        None => Err(counted(current.unwrap_or_default())),
    }
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
        "Submit an automated delivery with status review"
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
/// Whether `review` is one of the reviews this task's delivery flow
/// registered (a round's review, started by the flow or attached to it, at
/// any of its attempts): the flow's own mail tells its owner and recipient,
/// so a review's end sends no dispatcher copy for it (YN-12 S2,
/// pr_review/store.rs). Read only.
pub(crate) fn registers_review(db: &Connection, task: &str, review: &str) -> Result<bool> {
    Ok(load(db, task)?.is_some_and(|f| {
        f.rounds.iter().any(|r| {
            r.review.id.as_deref() == Some(review)
                || r.earlier.iter().any(|a| a.review.id.as_deref() == Some(review))
        })
    }))
}
/// Refuses a review request of this task's delivery flow that it moved past:
/// an earlier attempt's or an earlier round's, whatever candidate it names
/// (YN-12 S4). Such a request may never start a review: it is refused before
/// any candidate is matched, so naming the base an attempt was replaced
/// from can't start one unregistered. A request that already has a receipt
/// never gets here: its original review is returned (pr_review previous()).
pub(crate) fn refuse_replaced_request(db: &Connection, task: &str, request_id: &str) -> Result<()> {
    let Some(f) = load(db, task)? else {
        return Ok(());
    };
    let Some((last, before)) = f.rounds.split_last() else {
        return Ok(());
    };
    let replaced = before.iter().any(|r| r.review.request_id == request_id)
        || f.rounds.iter().flat_map(|r| &r.earlier).any(|a| a.review.request_id == request_id);
    ensure!(
        !replaced,
        "This delivery attempt was replaced by attempt {} of round {}; its request can't start a review. No review was started.",
        last.attempt(),
        last.number
    );
    Ok(())
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
    // Before matching: a replaced attempt's request naming its old base
    // would match no candidate and start unregistered (YN-12 S4).
    refuse_replaced_request(db, task, request_id)?;
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
    // A decider's beyond-limit round may attach to a round whose start the
    // limit refused; the review now exists, so that refusal no longer holds.
    r.review.limit_refused = None;
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
    if r.review.id.is_none() {
        if let Some(refused) = &r.review.limit_refused {
            return state(
                "needs_judgment",
                &format!("This PR's two started review rounds were used before this delivery round could start ({refused}). No reviewer ran and it isn't retried; whoever decides can start a round beyond the limit or judge without one."),
            );
        }
    }
    for (name, step) in [("Review", &r.review), ("CI subscription", &r.ci)] {
        if step.id.is_none() && step.attempts >= 3 {
            // Its three tries are used either way, and nothing tries again:
            // whoever decides is told (PR #901 R1). Only a step whose every
            // try recorded its end proves its setup failed, so
            // delivery_continue may retry it (YN-12 S4). `finished` is a
            // total, so the try whose end is missing may be any of them.
            let unrecorded = step.finished.is_some_and(|done| done < step.attempts);
            return Ok((
                "infrastructure_error",
                if unrecorded {
                    format!(
                        "{name} setup used its three starts with the same request ID, and the completion of one or more of them isn't recorded: they may still be in flight, or their result wasn't saved. No fourth start is made; check the original request and operation. Until that is confirmed, no replacement attempt can be authorized on it. This doesn't prove that the setup failed or that nothing ran. {}",
                        step.error.as_deref().unwrap_or("Completion was not confirmed.")
                    )
                } else {
                    format!(
                        "{name} setup failed after three attempts with the same request ID. Reconcile the retained operation; no replacement review is started. {}",
                        step.error
                            .as_deref()
                            .unwrap_or("Completion was not confirmed.")
                    )
                },
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
    // Its key now, not the one stored when the flow started (T-56).
    v["taskId"] = json!(collaboration::task_number(db, &f.task_id)?);
    v["state"] = json!(state);
    v["reason"] = json!(reason);
    v["candidate"] =
        json!({"flowId":f.id,"round":r.number,"baseSha":r.base_sha,"headSha":r.head_sha});
    // Only a round this Core wrote names its attempt; an older one reads as it did.
    if r.names_attempts() {
        v["attempt"] = json!(r.attempt());
    }
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
    /// The step's request ID when claimed: its finish writes to that step
    /// only, so a late one never lands on a newer attempt (YN-12 S4).
    request_id: String,
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
        if kind == "review" && settings(&tx, &f.task_id)? != r.settings && r.review.id.is_none() {
            let r = f.rounds.last_mut().unwrap();
            // The tries left end here without a call; one already in flight
            // (finished behind attempts) still hasn't.
            if let Some(done) = r.review.finished.as_mut() {
                *done += 3u8.saturating_sub(r.review.attempts);
            }
            r.review.attempts = 3;
            r.review.error = Some("The review settings for this task changed after authorization.".into());
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
        // A round the started-round limit refused is never retried; a person
        // decides, as the needs_judgment state says. A review a decider did
        // start beyond the limit has an id, and its round goes on.
        if step.id.is_none() && step.limit_refused.is_some() {
            tx.commit()?;
            return Ok(None);
        }
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
            request_id: step.request_id.clone(),
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
        // The step the plan was claimed for: the round's current one, or the
        // earlier attempt it became. A request the round no longer has gets
        // nothing written (YN-12 S4).
        let step = if plan.kind == "review" {
            if r.review.request_id == plan.request_id {
                Some(&mut r.review)
            } else {
                r.earlier.iter_mut().map(|a| &mut a.review).find(|s| s.request_id == plan.request_id)
            }
        } else {
            Some(&mut r.ci).filter(|s| s.request_id == plan.request_id)
        };
        let Some(step) = step else {
            return Ok(());
        };
        // This setup call has ended, whatever it answered.
        if let Some(done) = step.finished.as_mut() {
            *done = done.saturating_add(1);
        }
        match answer {
            Ok(value) => {
                step.id = Some(text(&value, "id")?.into());
                step.error = None;
                step.limit_refused = None;
            }
            Err(error) => {
                // The PR's started round limit refused the start: record it
                // distinctly, so state() reports needs_judgment and no retry.
                if error.starts_with("round_limit:") {
                    step.limit_refused = Some(error.clone());
                }
                step.error = Some(error);
            }
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
        let round = f.rounds.len();
        let r = f.rounds.last().unwrap();
        let (attempt, names) = (r.attempt(), r.names_attempts());
        // Each attempt is notified of its own states: its key carries the
        // attempt from the second on, so the first keeps the key older Cores
        // wrote, and a flow they wrote reads as unchanged as it did.
        let key = match attempt {
            1 => format!("{round}:{current}"),
            n => format!("{round}.{n}:{current}"),
        };
        let last_key = f.last_key.clone().unwrap_or_else(|| format!("{round}:{}", f.last_state));
        if f.last_state == current && last_key == key {
            tx.commit()?;
            return Ok(false);
        }
        f.last_state = current.into();
        if names {
            f.last_key = Some(key.clone());
        }
        let attempt_note = if names { format!(", attempt {attempt}/{MAX_ATTEMPTS}") } else { String::new() };
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
                let mut metadata = json!({"kind":"delivery","name":f.task_ref,"status":current,"deliveryId":f.id,"round":round});
                if names {
                    metadata["attempt"] = json!(attempt);
                }
                collaboration::insert_message(
                    &tx,
                    json!({"id":id,"seq":0,"sender":{"kind":"system","id":"core","name":"Yuzuno Core"},"recipient":recipient,"body":format!("{} delivery round {round}/{}{attempt_note}: {current}. {} PR {}. Read delivery_get(taskId={}) for fixed revision, review and CI evidence. This message does not authorize another paid review, merge or deployment.",f.task_ref,f.max_rounds,v["reason"].as_str().unwrap_or(""),f.url,f.task_ref),"taskId":f.task_id,"replyTo":null,"threadId":id,"createdAt":now(),"source":{"deliveryId":f.id},"priority":"normal","metadata":metadata}),
                )?;
            }
        }
        save(&tx, &f)?;
        tx.commit()?;
        Ok(true)
    }
}
