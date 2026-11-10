//! Applying an approved plan (YN-74 ①a2; design 2.4 to 2.6).
//!
//! The executor asks for approval with its own gate Ask: its question or
//! body names the plan's planId and sha256, and its form has a multi-choice
//! field `groups` whose options are exactly the plan's groups. Core reads the
//! user's answer itself, from the form answers Home checked and kept
//! (`project_brief_sections.reply_form`), never from text. `cleanup_apply`
//! takes the plan only when every check holds:
//!
//! - the caller is the plan's task's open executor, and the plan is the
//!   task's newest, still waiting and not expired;
//! - the Ask is that executor's own, at a gate step of its template, live,
//!   replied after the plan was registered, unchanged since the reply, and
//!   names the plan's planId and sha256;
//! - its form's `groups` options are the plan's group ids, and the user
//!   chose at least one group, each of them delete or rebuildable.
//!
//! The reply can only narrow it: `excludeItems` keeps items the user's words
//! exclude. Core then removes, in the background, each pending item of the
//! chosen groups after checking it again: the same file system object as
//! when it was planned, every registration check (roots, kind, rule,
//! freshness) passing now, no process using it (/proc), no running Job or
//! Agent in its folder and no Job record naming it. A scratch entry's
//! evidence files are kept first in a snapshot under Core's data folder. An
//! item is moved aside, checked to be the one moved, and removed without
//! following links; of a Cargo target folder only its planned profiles go,
//! each under its build locks. Whatever check cannot be made refuses the
//! item: Core keeps rather than guesses. This Core removes no worktree yet,
//! and nothing on another machine. The executor gets one mail when it ends,
//! and the task one line.
use super::*;
use crate::build_output::{hold_build_locks, mtime_ns, process_users, record_protections, REMOVING};
use std::io::Write as _;

/// How long one plan's checks may take while it is applied.
const APPLY_TIME: Duration = Duration::from_secs(6 * 3600);
/// Names of excluded items one call takes.
const MAX_EXCLUDED: usize = 2000;
/// This Core process: an approval records it, so recovery at start takes
/// only plans an earlier process left applying (review ae977525).
pub(super) static BOOT: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| uuid::Uuid::new_v4().to_string());

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ApplyInput {
    request_id: String,
    task_id: String,
    plan_id: String,
    ask_key: String,
    #[serde(default)]
    exclude_items: Vec<String>,
}

pub(super) fn tool_definition() -> Value {
    json!({"name":"cleanup_apply",
        "description":"Apply your task's cleanup plan once the user approved its groups on Home. Your gate Ask (askKey) must name the plan's planId and sha256 and have a multi-choice form field `groups` whose option ids are exactly the plan's group ids. Core reads the user's form answers itself: the Ask must be yours, at a gate step of your template, replied after the plan was registered and unchanged since. The plan must be your task's newest, not expired. Only chosen delete and rebuildable groups run; choosing a keep or ask group refuses the call. excludeItems keeps items the user's words exclude (it can only narrow). Core removes each pending item in the background after checking it again (same object, roots, rule, freshness, processes, Jobs, Agents, Job records); a scratch entry's evidence files go into a snapshot first. What any check refuses stays, with why. Worktrees and items on other machines are refused by this Core. You get one mail when it ends; cleanup_plan_get view items has each item's result. A retry with the same requestId answers with the plan's state.",
        "inputSchema":{"type":"object","additionalProperties":false,"required":["requestId","taskId","planId","askKey"],"properties":{
            "requestId":{"type":"string","minLength":1,"maxLength":128,"description":"Stable retry key. Reuse only when retrying exactly this operation and payload."},
            "taskId":{"type":"string","description":collaboration::TASK_ID},
            "planId":{"type":"string"},
            "askKey":{"type":"string","maxLength":97,"description":"The key of your gate Ask on Home."},
            "excludeItems":{"type":"array","maxItems":MAX_EXCLUDED,"items":{"type":"string"},"description":"Item ids to keep, as the user's reply says."}}}})
}

/// A refusal of the whole call: `code: why. Nothing was removed.`
fn refuse(code: &str, why: impl std::fmt::Display) -> anyhow::Error {
    anyhow::anyhow!("{code}: {why}. Nothing was removed.")
}

pub(super) async fn apply(ws: &Arc<Workspace>, actor: Option<String>, input: Value) -> Result<Value> {
    let digest = sha256(&input.to_string());
    let input: ApplyInput = serde_json::from_value(input).map_err(|e| anyhow::anyhow!("invalid_input: {e}"))?;
    ensure!((1..=128).contains(&input.request_id.len()), "invalid_input: requestId is 1 to 128 bytes");
    ensure!(input.exclude_items.len() <= MAX_EXCLUDED, "invalid_input: excludeItems holds at most {MAX_EXCLUDED}");
    let actor = actor.ok_or_else(|| refuse("not_executor", "only the task's own executor applies its cleanup plan"))?;
    // Refused while Core prepares an update; held until the plan is applied.
    let permit = ws.admission.enter_work()?;
    let (answer, started) = ws.stored(move |s| approve(s, &actor, &input, &digest)).await?;
    if let Some(plan) = started {
        let ws = ws.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) = run(&ws, &plan).await {
                eprintln!("[cleanup] applying plan {plan} failed: {error:#}");
                let _ = ws.stored(move |s| finish(s, &plan, Some(format!("{error:#}")))).await;
            }
            ws.collaboration_wakeup.notify_one();
        });
    }
    Ok(answer)
}

/// The ask that approves a plan, as stored.
struct Ask {
    owner: String,
    version: i64,
    kind: String,
    state: Option<String>,
    replied_at: Option<String>,
    data: Value,
    form: Option<Value>,
}

fn parse_time(at: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(at).ok().map(|t| t.with_timezone(&chrono::Utc))
}

/// Every check of the approval; on success the plan is applying, with the
/// approval recorded and the excluded items kept, and its id is returned to
/// run. A retry of the same call answers with the plan's state.
fn approve(store: &Store, actor: &str, input: &ApplyInput, digest: &str) -> Result<(Value, Option<String>)> {
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    let (task, _) = collaboration::task_key(&tx, &input.task_id)?;
    let own: Option<Option<String>> = tx
        .query_row("SELECT task_id FROM agent_roles WHERE agent_id=?1 AND kind='executor' AND archived_at IS NULL", [actor], |r| r.get(0))
        .optional()?;
    if own.flatten().as_deref() != Some(task.as_str()) {
        return Err(refuse("not_executor", format!("only {}'s own open executor applies its cleanup plan", input.task_id)));
    }
    let Some(plan) = plan(&tx, &input.plan_id)?.filter(|p| p.task == task) else {
        return Err(refuse("plan_not_found", "this task has no cleanup plan with this ID"));
    };
    let approval: Option<Value> = tx
        .query_row("SELECT approval FROM cleanup_plans WHERE id=?1", [&plan.id], |r| r.get::<_, Option<String>>(0))?
        .and_then(|raw| serde_json::from_str(&raw).ok());
    if let Some(approval) = &approval {
        if approval["requestId"] == input.request_id.as_str() {
            ensure!(approval["requestDigest"] == digest, "idempotency_conflict: requestId already applied this plan with other input");
            return Ok((apply_answer(&tx, &plan.id)?, None));
        }
    }
    expire(&tx)?;
    let state: String = tx.query_row("SELECT state FROM cleanup_plans WHERE id=?1", [&plan.id], |r| r.get(0))?;
    match state.as_str() {
        "submitted" => {}
        "applying" | "applied" => return Err(refuse("plan_applied", "this plan was applied already; register a new one for more")),
        "expired" => return Err(refuse("plan_expired", "this plan expired; register it again and ask again")),
        _ => return Err(refuse("plan_superseded", "a newer plan of this task cancelled this one, and its approval with it")),
    }
    let newest: String = tx.query_row("SELECT id FROM cleanup_plans WHERE task_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 1", [&task], |r| r.get(0))?;
    if newest != plan.id {
        return Err(refuse("plan_superseded", "a newer plan of this task was registered"));
    }
    let project = plan.project.clone().ok_or_else(|| refuse("approval_missing", "the plan's task is in no Project"))?;
    let ask: Option<Ask> = tx
        .query_row(
            "SELECT owner_id,version,kind,ask_state,replied_at,data,reply_form FROM project_brief_sections WHERE project_id=?1 AND key=?2 AND live=1",
            params![project, input.ask_key],
            |r| {
                Ok(Ask {
                    owner: r.get(0)?, version: r.get(1)?, kind: r.get(2)?, state: r.get(3)?, replied_at: r.get(4)?,
                    data: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(Value::Null),
                    form: r.get::<_, Option<String>>(6)?.and_then(|raw| serde_json::from_str(&raw).ok()),
                })
            },
        )
        .optional()?;
    let Some(ask) = ask.filter(|a| a.kind == "ask") else {
        return Err(refuse("approval_missing", format!("the Project's Home has no live ask `{}`", input.ask_key)));
    };
    if ask.owner != actor {
        return Err(refuse("approval_not_yours", "the ask is not yours: only your own gate ask approves your plan"));
    }
    let gate = &ask.data["ask"]["gate"];
    let gate_task = gate["taskId"].as_str().and_then(|t| collaboration::task_key(&tx, t).ok()).map(|(id, _)| id);
    let at_gate = match (gate_task, gate["step"].as_u64()) {
        (Some(id), Some(step)) if id == task => {
            crate::collaboration_store::executor_overview::may_ask_gate(&tx, actor, &input.task_id, step)?.is_ok()
        }
        _ => false,
    };
    if !at_gate {
        return Err(refuse("approval_not_gate", "the ask is not at a gate step of your task's template"));
    }
    if ask.state.as_deref() != Some("replied") {
        return Err(refuse("approval_missing", "the user has not answered the ask"));
    }
    let replied = ask.replied_at.as_deref().and_then(parse_time);
    let registered = parse_time(&plan.created_at);
    if !matches!((replied, registered), (Some(r), Some(p)) if r > p) {
        return Err(refuse("approval_stale", "the reply came before this plan was registered"));
    }
    let said = format!("{} {}", ask.data["ask"]["question"].as_str().unwrap_or_default(), ask.data["body"]);
    if !said.contains(&plan.id) || !said.contains(&plan.sha256) {
        return Err(refuse("approval_mismatch", "the ask does not name this plan's planId and sha256"));
    }
    let Some(reply) = ask.form.as_ref().filter(|f| f["version"] == ask.version) else {
        return Err(refuse("approval_form", "the reply has no form answers Home checked for this version of the ask (or the ask changed after it)"));
    };
    let form = &ask.data["ask"]["reply"]["form"];
    let field = form["fields"].as_array().into_iter().flatten().find(|f| f["id"] == "groups" && f["type"] == "multi");
    let offered: Vec<&str> = field.and_then(|f| f["options"].as_array()).into_iter().flatten().filter_map(|o| o["id"].as_str()).collect();
    let groups: Vec<(String, String)> = plan.data["groups"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| Some((g["id"].as_str()?.to_owned(), g["decision"].as_str()?.to_owned())))
        .collect();
    let mut sorted_offered = offered.clone();
    sorted_offered.sort_unstable();
    let mut sorted_groups: Vec<&str> = groups.iter().map(|(id, _)| id.as_str()).collect();
    sorted_groups.sort_unstable();
    if form["id"] != reply["formId"] || sorted_offered != sorted_groups {
        return Err(refuse("approval_form", "the ask's form field `groups` must offer exactly the plan's group ids"));
    }
    let chosen: Vec<String> = reply["answers"]["groups"].as_array().into_iter().flatten().filter_map(|g| g.as_str().map(str::to_owned)).collect();
    if chosen.is_empty() {
        return Err(refuse("approval_empty", "the user chose no group"));
    }
    for group in &chosen {
        match groups.iter().find(|(id, _)| id == group) {
            Some((_, decision)) if matches!(decision.as_str(), "delete" | "rebuildable") => {}
            Some((_, decision)) => {
                return Err(refuse("approval_keep", format!("group {group} is a {decision} group, which is never applied; ask again without it")));
            }
            None => return Err(refuse("approval_form", format!("the reply chose {group}, which is no group of the plan"))),
        }
    }
    let mut excluded = Vec::new();
    for item in &input.exclude_items {
        let changed = tx.execute(
            "UPDATE cleanup_items SET state='kept',result=?3,updated_at=?4 WHERE plan_id=?1 AND item_id=?2 AND state='pending'",
            params![plan.id, item, json!({"code": "excluded", "why": "Excluded as the user's reply says"}).to_string(), now()],
        )?;
        let known: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM cleanup_items WHERE plan_id=?1 AND item_id=?2)", params![plan.id, item], |r| r.get(0))?;
        if !known {
            return Err(refuse("invalid_input", format!("excludeItems names {item}, which is no item of the plan")));
        }
        if changed > 0 {
            excluded.push(item.clone());
        }
    }
    let summary = summary::all(&groups, &stored_items(&tx, &plan.id)?, settings::read(&tx)?.summary_paths as usize);
    let at = now();
    let record = json!({"requestId": input.request_id, "requestDigest": digest, "askKey": input.ask_key, "askVersion": ask.version,
        "repliedAt": ask.replied_at, "groups": chosen, "excluded": excluded, "by": {"kind": "user", "through": "Home"},
        "appliedBy": actor, "at": at, "summary": summary, "boot": BOOT.as_str()});
    tx.execute("UPDATE cleanup_plans SET state='applying',approved_at=?2,approval=?3 WHERE id=?1", params![plan.id, at, record.to_string()])?;
    let (author, source) = collaboration::actor_context(store, &tx, Some(actor))?;
    collaboration::activity(&tx, &task, "comment", &author, &json!({"cleanupPlan": {"planId": plan.id}, "agent": source}),
        json!({"body": format!("Cleanup plan {} approved on Home (groups {}{}); Core is applying it.", plan.id, chosen.join(", "),
            if excluded.is_empty() { String::new() } else { format!(", {} item(s) excluded", excluded.len()) })}))?;
    let answer = apply_answer(&tx, &plan.id)?;
    tx.commit()?;
    Ok((answer, Some(plan.id)))
}

/// The plan's items with Core's checks, as the summary reads them; an
/// item no longer pending counts as refused with its result.
fn stored_items(db: &Connection, plan: &str) -> Result<Vec<summary::Stored>> {
    let mut q = db.prepare("SELECT item_id,group_id,kind,path,state,pre,result FROM cleanup_items WHERE plan_id=?1 ORDER BY seq")?;
    let rows = q.query_map([plan], |r| {
        let state: String = r.get(4)?;
        let result: Value = r.get::<_, Option<String>>(6)?.and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
        let refusal = (state != "pending").then(|| {
            (result["code"].as_str().unwrap_or(&state).to_owned(), result["why"].as_str().unwrap_or_default().to_owned())
        });
        Ok(summary::Stored { id: r.get(0)?, group: r.get(1)?, kind: r.get(2)?, path: r.get(3)?, refusal,
            pre: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(Value::Null) })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

fn apply_answer(db: &Connection, plan: &str) -> Result<Value> {
    let found = super::plan(db, plan)?.context("plan_not_found")?;
    let approval: Value = db
        .query_row("SELECT approval FROM cleanup_plans WHERE id=?1", [plan], |r| r.get::<_, Option<String>>(0))?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    let mut counts = serde_json::Map::new();
    let mut q = db.prepare("SELECT state, COUNT(*) FROM cleanup_items WHERE plan_id=?1 GROUP BY state")?;
    for row in q.query_map([plan], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
        let (state, n) = row?;
        counts.insert(state, json!(n));
    }
    Ok(json!({"planId": found.id, "state": found.state, "sha256": found.sha256, "groups": approval["groups"], "excluded": approval["excluded"],
        "items": counts, "applied": found.data["applied"],
        "note": "Core removes the chosen groups' items in the background after checking each again, and mails you when it ends; cleanup_plan_get view items has each one's result."}))
}

/// A pending item to apply, as planned.
struct Planned {
    id: String,
    group: String,
    kind: String,
    path: String,
    pre: Value,
}

/// What became of one item: its state, and its result (code, why, bytes)
/// and snapshot.
pub(super) struct Outcome {
    pub state: &'static str,
    pub result: Value,
    pub snapshot: Option<Value>,
}

pub(super) fn outcome(state: &'static str, code: &str, why: impl Into<String>) -> Outcome {
    Outcome { state, result: json!({"code": code, "why": why.into()}), snapshot: None }
}

/// One removal, as either a manual plan's item or an automatic run's item
/// says it: where its snapshot goes, which task (if any) it belongs to, and
/// what its checks recorded. The checked execution path is the same for
/// both: automatic.rs must not remove anything its own preflight skipped.
pub(super) struct Removal<'a> {
    pub data: &'a Path,
    pub namespace: &'a str,
    pub task: &'a str,
    pub kind: &'a str,
    pub id: &'a str,
    pub path: &'a str,
    pub pre: &'a Value,
}

/// What run needs from the records, read once.
struct Run {
    plan: Plan,
    groups: Vec<String>,
    project_dir: Option<String>,
    others: Vec<String>,
    settings: Settings,
    items: Vec<Planned>,
}

fn load_run(store: &Store, id: &str) -> Result<Run> {
    let db = store.db.read()?;
    let plan = plan(&db, id)?.context("plan_not_found")?;
    let approval: Value = db
        .query_row("SELECT approval FROM cleanup_plans WHERE id=?1", [id], |r| r.get::<_, Option<String>>(0))?
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or(Value::Null);
    let groups: Vec<String> = approval["groups"].as_array().into_iter().flatten().filter_map(|g| g.as_str().map(str::to_owned)).collect();
    let projects = crate::projects::all(&db)?;
    let project_dir = projects.iter().find(|p| Some(&p.id) == plan.project.as_ref()).and_then(|p| p.default_dirs.get("local").cloned());
    let others = projects.iter().filter(|p| Some(&p.id) != plan.project.as_ref()).filter_map(|p| p.default_dirs.get("local").cloned()).collect();
    let mut q = db.prepare("SELECT item_id,group_id,kind,path,pre FROM cleanup_items WHERE plan_id=?1 AND state='pending' ORDER BY seq")?;
    let items = q
        .query_map([id], |r| {
            Ok(Planned { id: r.get(0)?, group: r.get(1)?, kind: r.get(2)?, path: r.get(3)?,
                pre: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(Value::Null) })
        })?
        .collect::<rusqlite::Result<_>>()?;
    Ok(Run { plan, groups, project_dir, others, settings: settings::read(&db)?, items })
}

fn save(store: &Store, plan: &str, item: &str, outcome: &Outcome) -> Result<()> {
    store.db.write()?.execute(
        "UPDATE cleanup_items SET state=?3,result=?4,snapshot=?5,updated_at=?6 WHERE plan_id=?1 AND item_id=?2",
        params![plan, item, outcome.state, outcome.result.to_string(), outcome.snapshot.as_ref().map(Value::to_string), now()],
    )?;
    Ok(())
}

/// Applies a plan whose approval was recorded: each pending item of the
/// chosen groups, one after another; the rest are kept.
async fn run(ws: &Arc<Workspace>, id: &str) -> Result<()> {
    let run = ws.stored({
        let id = id.to_owned();
        move |s| load_run(s, &id)
    })
    .await?;
    let ctx = match &run.project_dir {
        Some(dir) if run.plan.data["machine"].is_null() => {
            check::context(ws.cleanup.env(), ws.cleanup.mounts(), &ws.data_dir, dir, run.plan.project.as_deref(), &run.others, run.settings.clone()).await.map(|mut ctx| {
                ctx.deadline = Instant::now() + APPLY_TIME;
                ctx
            })
        }
        Some(_) => Err(anyhow::anyhow!("On another machine: Core removes only on its own host for now")),
        None => Err(anyhow::anyhow!("Its task's Project has no folder on this host")),
    };
    for item in &run.items {
        let outcome = if !run.groups.contains(&item.group) {
            outcome("kept", "notApproved", "Its group was not chosen")
        } else {
            match &ctx {
                Ok(ctx) => execute(ws, ctx, &run.plan, item).await,
                Err(error) => outcome("refused", "unchecked", format!("{error:#}")),
            }
        };
        let (store, plan, item_id) = (ws.store.clone(), run.plan.id.clone(), item.id.clone());
        crate::db::blocking(move || save(&store, &plan, &item_id, &outcome)).await?;
    }
    let plan = id.to_owned();
    ws.stored(move |s| finish(s, &plan, None)).await
}

/// The same file system object as when it was planned.
pub(super) fn same(path: &Path, pre: &Value) -> bool {
    std::fs::symlink_metadata(path).is_ok_and(|m| {
        Some(m.dev()) == pre["dev"].as_u64() && Some(m.ino()) == pre["ino"].as_u64() && pre["mtimeNs"].as_str() == Some(&mtime_ns(&m).to_string())
    })
}

/// Why the item's folder is in use now: processes on this host (/proc),
/// running Jobs and working Agents in `users_root`, Job records naming it.
pub(super) async fn in_use(ws: &Arc<Workspace>, users_root: &Path, path: &Path) -> Option<(&'static str, String)> {
    let unavailable = ws.cleanup.processes_unavailable();
    let target = path.to_path_buf();
    let processes = tokio::task::spawn_blocking(move || if unavailable { Err("/proc cannot be read".to_owned()) } else { process_users(&target) })
        .await
        .unwrap_or_else(|error| Err(error.to_string()));
    match processes {
        Ok(users) if users.is_empty() => {}
        Ok(users) => return Some(("inUse", users.into_iter().take(3).collect::<Vec<_>>().join("; "))),
        Err(why) => return Some(("unchecked", format!("This host cannot check the processes using it: {why}"))),
    }
    let reasons = record_protections(ws, users_root, path).await;
    (!reasons.is_empty()).then(|| ("inUse", reasons.join("; ")))
}

/// One item: every check again, then its snapshot and its removal.
async fn execute(ws: &Arc<Workspace>, ctx: &check::Context, plan: &Plan, item: &Planned) -> Outcome {
    if !plan.data["machine"].is_null() {
        return outcome("refused", "remote", "On another machine: Core removes only on its own host for now");
    }
    let task = plan.data["taskKey"].as_str().unwrap_or(&plan.task);
    execute_checked(ws, ctx, &Removal { data: &ws.data_dir, namespace: &plan.id, task, kind: &item.kind, id: &item.id,
        path: &item.path, pre: &item.pre }).await
}

/// The checks every removal makes just before it: the same object as when it
/// was checked, every registration check again, and no process, Job or Agent
/// using it. Ok is the item's state now and the folder Jobs and Agents are
/// looked for in; Err is what stops it.
pub(super) async fn checked_now(ws: &Arc<Workspace>, ctx: &check::Context, item: &Removal<'_>)
    -> std::result::Result<(Value, PathBuf), Outcome> {
    let path = PathBuf::from(item.path);
    if !same(&path, item.pre) {
        return Err(outcome("refused", "changed", "It changed since it was checked"));
    }
    let given = check::Item { id: item.id.to_owned(), group: "automatic".to_owned(), kind: item.kind.to_owned(),
        rule: item.pre["rule"].as_str().map(str::to_owned), path: item.path.to_owned(), save_diff: item.pre["saveDiff"] == true };
    let now = check::preflight(ctx, &given).await;
    if let Some((code, why)) = now.refusal {
        return Err(outcome("refused", code, why));
    }
    if now.pre["dev"] != item.pre["dev"] || now.pre["ino"] != item.pre["ino"] {
        return Err(outcome("refused", "changed", "It changed since it was checked"));
    }
    // Jobs and Agents are looked for in its working tree, or in its scratch entry.
    let users_root = match now.pre["tree"].as_str() {
        Some(tree) => PathBuf::from(tree),
        None => ctx.scratch.iter().find_map(|root| {
            path.strip_prefix(root).ok().and_then(|rest| rest.components().next()).map(|first| root.join(first))
        }).unwrap_or_else(|| path.clone()),
    };
    if let Some((code, why)) = in_use(ws, &users_root, &path).await {
        return Err(outcome("refused", code, why));
    }
    Ok((now.pre, users_root))
}

/// The checked execution path both a manual plan's item and an automatic
/// run's cache item go through: its checks, then its snapshot and removal.
pub(super) async fn execute_checked(ws: &Arc<Workspace>, ctx: &check::Context, item: &Removal<'_>) -> Outcome {
    let path = PathBuf::from(item.path);
    let now_pre = match checked_now(ws, ctx, item).await {
        Ok((now_pre, _users)) => now_pre,
        Err(outcome) => return outcome,
    };
    let bytes = now_pre["bytes"].clone();
    let now = check::Checked { refusal: None, pre: now_pre.clone() };
    if item.kind == "worktree" {
        return match worktrees::reclaim(ctx, item.data, item.namespace, item.task, item.id, &path, item.pre, &now.pre).await {
            Ok((record, snapshot)) => {
                let mut result = json!({"code": "removed", "bytes": bytes});
                for (key, value) in record.as_object().into_iter().flatten() {
                    result[key] = value.clone();
                }
                Outcome { state: "removed", result, snapshot: Some(snapshot) }
            }
            // What it made (its pinned HEAD, its snapshot) stays on record (review daaf3749).
            Err((code, why, record, snapshot)) => {
                let state = match code {
                    "partial" => "partial",
                    "failed" => "failed",
                    _ => "refused",
                };
                let mut result = json!({"code": code, "why": why});
                for (key, value) in record.as_ref().and_then(Value::as_object).into_iter().flatten() {
                    result[key] = value.clone();
                }
                Outcome { state, result, snapshot }
            }
        };
    }
    let mut snapshot = None;
    if item.kind == "entry" {
        let out = item.data.join("cleanup-snapshots").join(item.namespace).join(format!("{}.tar.gz", item.id));
        let (suffixes, limit) = (ctx.settings.evidence_suffixes.clone(), u64::from(ctx.settings.evidence_file_mib) << 20);
        let source = path.clone();
        let made = tokio::task::spawn_blocking(move || keep_evidence(&source, &out, &suffixes, limit)).await;
        match made {
            Ok(Ok(kept)) => snapshot = kept,
            Ok(Err(error)) => return outcome("refused", "snapshot", format!("Its snapshot could not be made: {error:#}")),
            Err(error) => return outcome("refused", "snapshot", format!("Its snapshot could not be made: {error}")),
        }
    }
    let removal = match (item.kind, item.pre["rule"].as_str()) {
        ("cache-dir", Some("cargo")) => {
            // Only the profiles planned, each still the one planned.
            let planned: Vec<Value> = item.pre["profiles"].as_array().cloned().unwrap_or_default();
            let current: Vec<Value> = now.pre["profiles"].as_array().cloned().unwrap_or_default();
            let target = path.clone();
            tokio::task::spawn_blocking(move || remove_profiles(&target, &planned, &current)).await.unwrap_or_else(|e| Err(("failed", e.to_string())))
        }
        _ => {
            let (dev, ino) = (item.pre["dev"].as_u64(), item.pre["ino"].as_u64());
            let target = path.clone();
            tokio::task::spawn_blocking(move || remove_aside(&target, dev, ino).map(|note| (note, true)))
                .await
                .unwrap_or_else(|e| Err(("failed", e.to_string())))
        }
    };
    match removal {
        Ok((note, whole)) => {
            // Its size was measured over everything planned: when part of it
            // stayed, how much went is not known (review ae977525).
            let bytes = if whole { bytes } else { Value::Null };
            Outcome { state: "removed", result: json!({"code": "removed", "bytes": bytes, "note": note}), snapshot }
        }
        Err((state, why)) => Outcome {
            state: if state == "partial" { "partial" } else if state == "failed" { "failed" } else { "refused" },
            result: json!({"code": state, "why": why}),
            snapshot,
        },
    }
}

/// Moves path aside in its folder, checks it is the object planned, and
/// removes it without following links.
pub(super) fn remove_aside(path: &Path, dev: Option<u64>, ino: Option<u64>) -> std::result::Result<Option<String>, (&'static str, String)> {
    let parent = path.parent().ok_or(("refused", "It has no parent folder".to_owned()))?;
    let aside = parent.join(format!("{REMOVING}{}", uuid::Uuid::new_v4()));
    std::fs::rename(path, &aside).map_err(|e| ("refused", format!("It could not be moved aside: {e}")))?;
    let meta = std::fs::symlink_metadata(&aside);
    let moved = meta.as_ref().is_ok_and(|m| Some(m.dev()) == dev && Some(m.ino()) == ino);
    if !moved {
        let back = std::fs::rename(&aside, path);
        return Err(("refused", format!("It was replaced while being removed; {}",
            if back.is_ok() { "it was put back".to_owned() } else { format!("it is left at {}", aside.display()) })));
    }
    let removed = if meta.is_ok_and(|m| m.is_dir()) { std::fs::remove_dir_all(&aside) } else { std::fs::remove_file(&aside) };
    removed.map(|()| None).map_err(|e| ("partial", format!("Removing it stopped: {e}; what remains is at {}", aside.display())))
}

/// Every build lock Cargo keeps in one of its subtrees (check.rs
/// `cargo_profiles`): a profile's own, and each profile's in a target
/// triple's or the build-dir folder; none in doc, package or tmp, or in a
/// profile left without its lock. Each is held until the subtree is moved.
fn hold_locks_within(path: &Path) -> std::result::Result<Vec<std::fs::File>, String> {
    let mut dirs = vec![path.to_path_buf()];
    if let Ok(entries) = std::fs::read_dir(path) {
        dirs.extend(entries.flatten().filter(|e| e.file_type().is_ok_and(|t| t.is_dir())).map(|e| e.path()));
    }
    let mut held = Vec::new();
    for dir in dirs {
        if std::fs::symlink_metadata(dir.join(".cargo-lock")).is_ok_and(|m| m.is_file()) {
            held.extend(hold_build_locks(&dir)?);
        }
    }
    Ok(held)
}

/// The planned Cargo profiles of a target folder that are still the ones
/// planned, each removed under its build locks; everything else stays.
/// With what was done, and whether every planned profile went.
fn remove_profiles(target: &Path, planned: &[Value], current: &[Value]) -> std::result::Result<(Option<String>, bool), (&'static str, String)> {
    let (mut removed, mut kept) = (Vec::new(), Vec::new());
    for profile in planned {
        let name = profile["name"].as_str().unwrap_or_default();
        let unchanged = current.iter().any(|c| c == profile);
        let path = target.join(name);
        if name.is_empty() || !unchanged {
            kept.push(format!("{name}: it changed since the plan"));
            continue;
        }
        let locks = match hold_locks_within(&path) {
            Ok(locks) => locks,
            Err(why) => {
                kept.push(format!("{name}: {why}"));
                continue;
            }
        };
        let parent = path.parent().ok_or(("refused", "It has no parent folder".to_owned()))?;
        let aside = parent.join(format!("{REMOVING}{}", uuid::Uuid::new_v4()));
        if let Err(e) = std::fs::rename(&path, &aside) {
            kept.push(format!("{name}: it could not be moved aside: {e}"));
            continue;
        }
        let moved = std::fs::symlink_metadata(&aside)
            .is_ok_and(|m| m.is_dir() && Some(m.dev()) == profile["dev"].as_u64() && Some(m.ino()) == profile["ino"].as_u64());
        if !moved {
            let _ = std::fs::rename(&aside, &path);
            kept.push(format!("{name}: it was replaced while being removed"));
            continue;
        }
        drop(locks);
        if let Err(e) = std::fs::remove_dir_all(&aside) {
            // What went before it and what stayed are said too.
            let before = if removed.is_empty() { String::new() } else { format!("; removed before it: {}", removed.join(", ")) };
            let stayed = if kept.is_empty() { String::new() } else { format!("; kept: {}", kept.join("; ")) };
            return Err(("partial", format!("Removing {name} stopped: {e}; what remains is at {}{before}{stayed}", aside.display())));
        }
        removed.push(name.to_owned());
    }
    if removed.is_empty() {
        return Err(("refused", format!("No planned profile could be removed: {}", kept.join("; "))));
    }
    let whole = kept.is_empty();
    Ok((Some(if whole { format!("Removed {}", removed.join(", ")) } else { format!("Removed {}; kept {}", removed.join(", "), kept.join("; ")) }), whole))
}

/// A scratch entry's evidence files (the settings' suffixes, each at most
/// `limit` bytes), never following links, as a tar.gz at `out` with its
/// sha256. None when it holds none.
fn keep_evidence(entry: &Path, out: &Path, suffixes: &[String], limit: u64) -> Result<Option<Value>> {
    let evidence = |path: &Path, meta: &std::fs::Metadata| {
        let suffix = path.extension().map(|e| e.to_string_lossy().to_ascii_lowercase());
        meta.is_file() && meta.len() <= limit && suffix.is_some_and(|s| suffixes.contains(&s))
    };
    let mut files: Vec<(PathBuf, PathBuf)> = Vec::new();
    let top = std::fs::symlink_metadata(entry)?;
    let name = PathBuf::from(entry.file_name().context("an entry has a name")?);
    if top.is_dir() {
        let mut stack = vec![entry.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for found in std::fs::read_dir(&dir)? {
                let found = found?;
                let meta = std::fs::symlink_metadata(found.path())?;
                if meta.is_dir() {
                    stack.push(found.path());
                } else if evidence(&found.path(), &meta) {
                    let relative = found.path().strip_prefix(entry).map(|r| name.join(r)).unwrap_or_else(|_| name.clone());
                    files.push((found.path(), relative));
                }
            }
        }
    } else if evidence(entry, &top) {
        files.push((entry.to_path_buf(), name.clone()));
    }
    if files.is_empty() {
        return Ok(None);
    }
    files.sort();
    std::fs::create_dir_all(out.parent().context("a snapshot has a folder")?)?;
    let file = std::fs::File::create(out)?;
    let mut tar = tar::Builder::new(flate2::write::GzEncoder::new(file, flate2::Compression::default()));
    tar.follow_symlinks(false);
    let mut bytes = 0u64;
    for (path, relative) in &files {
        let mut source = std::fs::File::open(path)?;
        tar.append_file(relative, &mut source)?;
        bytes += source.metadata()?.len();
    }
    let mut written = tar.into_inner()?.finish()?;
    written.flush()?;
    drop(written);
    let sha = {
        use sha2::{Digest, Sha256};
        format!("{:x}", Sha256::digest(std::fs::read(out)?))
    };
    Ok(Some(json!({"at": now(), "path": out, "sha256": sha, "files": files.len(), "bytes": bytes})))
}

/// The plan is applied: the rest of its pending items are kept, the task
/// gets one line and the executor one mail. `error`: why it stopped early.
fn finish(store: &Store, id: &str, error: Option<String>) -> Result<()> {
    let mut db = store.db.write()?;
    let tx = db.transaction()?;
    let Some(plan) = plan(&tx, id)? else { return Ok(()) };
    if plan.state != "applying" {
        return Ok(());
    }
    let why = error.clone().unwrap_or_else(|| "It was not reached".to_owned());
    tx.execute(
        "UPDATE cleanup_items SET state='kept',result=?2,updated_at=?3 WHERE plan_id=?1 AND state='pending'",
        params![id, json!({"code": "stopped", "why": why}).to_string(), now()],
    )?;
    let mut counts: BTreeMap<String, (i64, u64)> = BTreeMap::new();
    let mut q = tx.prepare("SELECT state, result FROM cleanup_items WHERE plan_id=?1")?;
    for row in q.query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, Option<String>>(1)?)))? {
        let (state, result) = row?;
        let bytes = result.and_then(|r| serde_json::from_str::<Value>(&r).ok()).and_then(|r| r["bytes"].as_u64()).unwrap_or(0);
        let entry = counts.entry(state).or_default();
        entry.0 += 1;
        entry.1 += bytes;
    }
    drop(q);
    let n = |state: &str| counts.get(state).map_or(0, |c| c.0);
    let freed = counts.get("removed").map_or(0, |c| c.1);
    let applied = json!({"at": now(), "removed": n("removed"), "freedBytes": freed, "refused": n("refused"), "kept": n("kept"),
        "partial": n("partial"), "failed": n("failed"), "error": error});
    tx.execute("UPDATE cleanup_plans SET state='applied', data=json_set(data,'$.applied',json(?2)) WHERE id=?1", params![id, applied.to_string()])?;
    let gib = freed as f64 / (1u64 << 30) as f64;
    let body = format!(
        "Cleanup plan {id} applied: {} item(s) removed, about {gib:.2} GiB freed; {} refused by Core's checks, {} kept{}{}.",
        n("removed"), n("refused"), n("kept"),
        if n("partial") + n("failed") > 0 { format!(", {} partly removed or failed", n("partial") + n("failed")) } else { String::new() },
        error.as_ref().map(|e| format!("; it stopped early: {e}")).unwrap_or_default()
    );
    let core = TaskActor { kind: "system".into(), id: "core".into(), name: "Yuzuno Core".into() };
    collaboration::activity(&tx, &plan.task, "comment", &core, &json!({"cleanupPlan": {"planId": id}}), json!({"body": body}))?;
    let name: String = tx
        .query_row("SELECT json_extract(data,'$.agent.name') FROM agents WHERE id=?1", [&plan.author], |r| r.get::<_, Option<String>>(0))
        .optional()?
        .flatten()
        .unwrap_or_else(|| plan.author.clone());
    let message = uuid::Uuid::new_v4().to_string();
    collaboration::insert_message(&tx, json!({"id": message, "seq": 0, "sender": {"kind": "system", "id": "core", "name": "Yuzuno Core"},
        "recipient": {"kind": "agent", "id": plan.author, "name": name},
        "body": format!("{body} Read cleanup_plan_get(planId={id}, view=items) for each item's result, then check with an inventory and report on the task."),
        "taskId": plan.task, "replyTo": null, "threadId": message, "createdAt": now(), "source": {"cleanupPlan": id}, "priority": "normal",
        "metadata": {"kind": "cleanup", "status": "applied", "planId": id}}))?;
    tx.commit()?;
    Ok(())
}

/// Plans a stopped Core left applying: what was not reached is kept, and
/// their executors are told. Nothing is retried. A plan this process
/// started applying is its own and is left to it.
pub(super) fn recover(store: &Store) -> Result<usize> {
    let ids: Vec<String> = {
        let db = store.db.read()?;
        let mut q = db.prepare("SELECT id FROM cleanup_plans WHERE state='applying' AND COALESCE(json_extract(approval,'$.boot'),'')<>?1")?;
        let rows = q.query_map([BOOT.as_str()], |r| r.get(0))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    for id in &ids {
        finish(store, id, Some("Core stopped while applying it; register a new plan for what is left".to_owned()))?;
    }
    Ok(ids.len())
}
