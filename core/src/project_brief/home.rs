//! Home (GET /api/home): every Project's Brief beside the facts Core holds
//! about it (its Agents, their requests and errors, its Jobs), and the
//! "needs you" strip across Projects. Project Priority only orders this
//! view; it never changes scheduling.
use super::{sections, *};
use crate::model::{Agent, MessageInput, MessageReceipt, PendingRequest};
use chrono::{DateTime, Utc};
use std::collections::{hash_map::Entry, HashMap};

const ORDER_KEY: &str = "home.projectOrder";
const MAX_REPLY: usize = 20_000;

fn stored_order(store: &Store) -> Result<Vec<String>> {
    let raw: Option<String> = store.db.read()?
        .query_row("SELECT value FROM workspace_meta WHERE key=?1", [ORDER_KEY], |r| r.get(0))
        .optional()?;
    Ok(raw.and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default())
}

/// Active Projects in the user's order, then any the order does not name
/// yet, oldest first.
fn effective(projects: &[crate::projects::Project], stored: &[String]) -> Vec<String> {
    let active: Vec<&str> = projects.iter().filter(|p| p.archived_at.is_none()).map(|p| p.id.as_str()).collect();
    let mut order: Vec<String> = stored.iter().filter(|id| active.contains(&id.as_str())).cloned().collect();
    for id in active {
        if !order.iter().any(|known| known == id) {
            order.push(id.into());
        }
    }
    order
}

/// Stores the Project Priority order and returns it as Home applies it.
pub(super) fn set_order(store: &Store, ids: &[String]) -> Result<Vec<String>> {
    ensure!(ids.len() <= 500, "At most 500 Projects can be ordered");
    let projects = store.projects()?;
    for (index, id) in ids.iter().enumerate() {
        ensure!(projects.iter().any(|p| &p.id == id), "project_not_found: no Project has ID {id}");
        ensure!(!ids[..index].contains(id), "Project {id} is listed twice");
    }
    store.db.write()?.execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![ORDER_KEY, serde_json::to_string(ids)?],
    )?;
    Ok(effective(&projects, ids))
}

fn time(at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(at).ok().map(|at| at.with_timezone(&Utc))
}

fn request_title(request: &PendingRequest) -> String {
    if request.stale {
        return "Reconnect to confirm this request".into();
    }
    let params = &request.params;
    params["reason"].as_str()
        .or_else(|| params["command"].as_str())
        .or_else(|| params["questions"][0]["question"].as_str())
        .or_else(|| params["toolName"].as_str())
        .map(|text| text.chars().take(200).collect())
        .unwrap_or_else(|| "Needs your response".into())
}

/// The ProjectPanel counts of web/src/home/types.ts.
fn counts(members: &[&Agent]) -> Value {
    let mut counts = HashMap::from([("working", 0), ("idle", 0), ("waiting", 0), ("error", 0), ("offline", 0)]);
    for agent in members {
        let status = match agent.status.as_str() {
            status @ ("working" | "idle" | "waiting" | "error") => status,
            _ => "offline",
        };
        *counts.get_mut(status).unwrap() += 1;
    }
    json!({"working":counts["working"],"idle":counts["idle"],"waiting":counts["waiting"],
        "error":counts["error"],"offline":counts["offline"],"total":members.len()})
}

struct LiveJob {
    project: Option<String>,
    shown: Value,
}

/// Queued Jobs and those still holding a reservation (the Jobs list's live
/// set), each under its task's Project, else its Agent's.
fn live_jobs(db: &Connection, agents: &HashMap<String, Agent>) -> Result<Vec<LiveJob>> {
    let mut query = db.prepare(
        "SELECT j.id,j.agent_id,j.status,j.data,pt.project_id,pa.project_id FROM local_jobs j
         LEFT JOIN project_tasks pt ON pt.task_id=j.task_id LEFT JOIN project_agents pa ON pa.agent_id=j.agent_id
         WHERE j.reserved=1 OR j.status='queued' ORDER BY j.seq LIMIT 500",
    )?;
    let rows = query.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?,
            r.get::<_, Option<String>>(4)?, r.get::<_, Option<String>>(5)?))
    })?;
    let mut jobs = vec![];
    for row in rows {
        let (id, agent, status, data, task_project, agent_project) = row?;
        let data: Value = serde_json::from_str(&data)?;
        let name = data["agent"]["name"].as_str().map(str::to_owned).or_else(|| agents.get(&agent).map(|a| a.name.clone()));
        jobs.push(LiveJob {
            project: task_project.or(agent_project),
            shown: json!({"id":id,"name":data["name"],"status":status,"agentId":agent,"agentName":name,"taskRef":data["taskRef"]}),
        });
    }
    Ok(jobs)
}

fn missing(store: &Store, db: &Connection, project: &str, agents: &HashMap<String, Agent>) -> Result<Vec<Value>> {
    let since = (Utc::now() - chrono::Duration::hours(MISSING_HOURS)).to_rfc3339();
    let mut query = db.prepare(
        "SELECT agent_id,turn_id,outcome,updated_at FROM project_brief_turns WHERE project_id=?1 AND updated_at>=?2
         AND outcome IN ('missing','remindFailed','reminded') ORDER BY updated_at DESC",
    )?;
    let rows = query.query_map(params![project, since], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?))
    })?;
    let mut missing = vec![];
    // Many outcomes can belong to the same Agent. Recheck each source once
    // for this build, without retaining permissions across Home refreshes.
    let mut permissions = HashMap::new();
    for row in rows {
        let (agent, turn, outcome, at) = row?;
        let allowed = match permissions.entry(agent.clone()) {
            Entry::Occupied(entry) => *entry.get(),
            Entry::Vacant(entry) => *entry.insert(editors::can_edit(store, db, project, &agent)?),
        };
        if !allowed { continue; }
        let name = agents.get(&agent).map_or("Deleted Agent", |a| a.name.as_str());
        missing.push(json!({"agentId":agent,"agentName":name,"turnId":turn,"at":at,"outcome":outcome}));
        if missing.len() == 50 { break; }
    }
    Ok(missing)
}

/// The HomeData of web/src/home/types.ts.
pub(super) fn build(store: &Store) -> Result<Value> {
    let at = Utc::now();
    // Each of these takes its own reader; the Briefs are read on one after.
    let agents = store.agents()?;
    let by_id: HashMap<String, Agent> = agents.iter().map(|a| (a.id.clone(), a.clone())).collect();
    // Only the requests of Agents with requests waiting, not their records:
    // Home is rebuilt on every change while one waits (T-120).
    let mut pending: HashMap<&str, Vec<PendingRequest>> = HashMap::new();
    for agent in agents.iter().filter(|a| a.closed_at.is_none() && a.pending_count > 0) {
        match store.pending(&agent.id) {
            Ok(requests) => {
                pending.insert(agent.id.as_str(), requests);
            }
            Err(error) => eprintln!("Home skipped the requests of Agent {}: {error:#}", agent.id),
        }
    }
    let projects = store.projects()?;
    let order = effective(&projects, &stored_order(store)?);
    let rank: HashMap<&str, usize> = order.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
    let db = store.db.read()?;
    let mut refs = super::refs::Refs::new(store, &db);
    let jobs = live_jobs(&db, &by_id)?;
    let mut needs: Vec<(usize, Option<DateTime<Utc>>, Value)> = vec![];
    for agent in agents.iter().filter(|a| a.closed_at.is_none()) {
        for request in pending.get(agent.id.as_str()).into_iter().flatten() {
            let priority = agent.project_id.as_deref().and_then(|id| rank.get(id)).copied().unwrap_or(usize::MAX);
            needs.push((priority, time(&request.created_at), json!({"kind":"approval","projectId":agent.project_id,
                "agentId":agent.id,"agentName":agent.name,"requestId":request.id,"title":request_title(request),
                "since":request.created_at})));
        }
    }
    let mut panels = vec![];
    for (priority, id) in order.iter().enumerate() {
        let Some(project) = projects.iter().find(|p| &p.id == id) else { continue };
        let members: Vec<&Agent> = agents.iter().filter(|a| a.closed_at.is_none() && a.project_id.as_deref() == Some(id)).collect();
        let errors: Vec<Value> = members.iter().filter_map(|a| {
            a.error.as_ref().map(|message| json!({"agentId":a.id,"agentName":a.name,"message":message,"at":a.updated_at}))
        }).collect();
        let mut requests = vec![];
        for agent in &members {
            for request in pending.get(agent.id.as_str()).into_iter().flatten() {
                let mut shown = serde_json::to_value(request)?;
                shown["agentName"] = json!(agent.name);
                requests.push(shown);
            }
        }
        let live = sections::live(&db, id)?;
        let policy = editors::policy(&db, id)?;
        // A source filter, never a Seen mark or deletion. All Asks remain
        // reachable, including a subtopic whose regular parent is hidden.
        let visible: Vec<_> = live.iter().filter(|row| row.kind == "ask"
            || policy.editor_agent_ids.is_none()
            || (policy.includes(&row.owner_id) && members.iter().any(|a| a.id == row.owner_id)))
            .cloned().collect();
        let team: Vec<_> = live.iter().filter(|row| !visible.iter().any(|shown| shown.key == row.key)).cloned().collect();
        let history = sections::history(&db, id)?;
        let seen = sections::seen(&db, id)?;
        let owner = |row: &sections::Row| {
            let agent = by_id.get(&row.owner_id).map(|a| sections::OwnerAgent {
                closed: a.closed_at.is_some(), name: a.name.as_str(), project: a.project_id.as_deref() });
            sections::owner(agent, row)
        };
        for row in live.iter().filter(|row| row.kind == "ask" && row.ask_state.as_deref() == Some("open")) {
            if row.deferred_until.as_deref().and_then(time).is_some_and(|until| until > at) {
                continue;
            }
            let since = row.ask_since.clone().unwrap_or_else(|| row.updated_at.clone());
            needs.push((priority, time(&since), json!({"kind":"ask","projectId":id,"agentId":row.owner_id,
                "agentName":owner(row).name,"sectionKey":row.key,"title":row.data["title"],"since":since})));
        }
        // id is the section's identity on Home: the same through every put
        // and edit of it, and through a report the user marked seen that its
        // owner then writes again; a section removed and written again has
        // a new one, so a widget pinned to the old one never shows it. A
        // history entry says why it is history and whether its source is
        // one Home shows now (the same test as `visible`).
        let current = |row: &sections::Row| row.kind == "ask" || policy.editor_agent_ids.is_none()
            || (policy.includes(&row.owner_id) && members.iter().any(|a| a.id == row.owner_id));
        let mut shown = |rows: &[sections::Row]| -> Vec<Value> {
            rows.iter().map(|row| {
                let mut section = sections::section_json(row, &owner(row), seen.get(&row.key), refs.of(&row.data["body"]), at);
                section["id"] = json!(row.identity);
                if !row.live {
                    section["historyReason"] = json!(row.history_reason);
                    section["currentSource"] = json!(current(row));
                }
                section
            }).collect()
        };
        panels.push(json!({
            "project":{"id":project.id,"name":project.name},
            "agents":counts(&members),
            "errors":errors,
            "pending":requests,
            "jobs":jobs.iter().filter(|job| job.project.as_deref() == Some(id)).map(|job| job.shown.clone()).collect::<Vec<_>>(),
            "contentEditors":policy,
            "brief":{"version":sections::brief_version(&db, id)?,"sections":shown(&visible),"teamSections":shown(&team),"history":shown(&history)},
            "unseen":sections::unseen(&visible, &seen),
            "missing":missing(store, &db, id, &by_id)?,
        }));
    }
    // By Project Priority, then the longest wait first.
    needs.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    Ok(json!({"generatedAt":now(),"order":order,"needsYou":needs.into_iter().map(|n| n.2).collect::<Vec<_>>(),"projects":panels}))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ReplyInput {
    #[serde(default)]
    pub key: Option<String>,
    pub agent_id: String,
    #[serde(default)]
    pub text: String,
    pub client_message_id: String,
    #[serde(default)]
    pub choice: Option<String>,
    /// A reply to a report or status card: the version of `key` on screen
    /// when the user began it, and its title there (see card_reply).
    #[serde(default)]
    pub version: Option<i64>,
    #[serde(default)]
    pub title: Option<String>,
    /// A reply to an ask (T-9): the version of `key` on screen when the user
    /// began it, and the Workspace whose Home showed it (see ask_reply).
    /// Never with `version`, which is a card's.
    #[serde(default)]
    pub ask_version: Option<i64>,
    #[serde(default)]
    pub workspace_id: Option<String>,
    /// A form's answers (T-9), beside the text Home writes of them: by
    /// field id, option ids for a choice. Checked against the form of the
    /// ask's version the user saw, and the text must say exactly these
    /// answers (form_answers); the text is still what the Agent gets.
    #[serde(default)]
    pub form: Option<FormReply>,
}

#[derive(serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct FormReply {
    pub form_id: String,
    pub answers: serde_json::Map<String, Value>,
}

/// What a reply's receipt keeps of it as the user saw it (T-9): `origin.home`,
/// read back only to show the reply (input_origin::annotate), never sent to
/// the Agent. Nothing in it is read from the section as it is later.
fn snapshot(project: &str, row: Option<&sections::Row>, title: Option<&str>, choice: Option<&(String, String)>, text: Option<&str>, form: Option<Value>) -> Value {
    let ask = row.filter(|row| row.kind == "ask").map(|row| &row.data["ask"]);
    let options = ask.map(|ask| {
        let reply = &ask["reply"];
        let mut options: Vec<&Value> = reply["options"].as_array().into_iter().flatten().collect();
        options.extend([&reply["choice"]["a"], &reply["choice"]["b"]].into_iter().filter(|option| option.is_object()));
        options.into_iter().filter_map(|option| {
            let id = option["id"].as_str()?;
            Some(json!({"id":id,"label":option["label"].as_str().unwrap_or(id)}))
        }).collect::<Vec<_>>()
    });
    json!({
        "format":crate::input_origin::HOME_FORMAT,
        "projectName":project,
        "sectionKind":row.map(|row| &row.kind),
        "title":title.or(row.and_then(|row| row.data["title"].as_str())),
        "question":ask.and_then(|ask| ask["question"].as_str()),
        "options":options,
        "choice":choice.map(|(id, label)| json!({"id":id,"label":label})),
        "text":text,
        "form":form,
    })
}

/// A form reply's answers (T-9) as the ask's version offered them: each
/// field's label and answer, an option id read as its label. They are the
/// answers the form takes (clarification.ts, clarificationAnswers), and the
/// reply's text must be exactly what Home writes of them (AskReply.tsx,
/// formText): readable lines, then the same ids. So what is kept and what
/// the Agent reads are the same answers; anything else sends nothing.
fn form_answers(row: &sections::Row, reply: &FormReply, text: &str) -> Result<Value> {
    let refused = |why: String| not_submitted(format!("{why}. Nothing was sent, and your answers are kept."));
    let form = &row.data["ask"]["reply"]["form"];
    if form["id"].as_str() != Some(reply.form_id.as_str()) {
        return Err(refused("form_not_found: this version of the ask has no such form".into()));
    }
    let fields = form["fields"].as_array().map(Vec::as_slice).unwrap_or_default();
    if reply.answers.len() != fields.len() || !fields.iter().all(|field| field["id"].as_str().is_some_and(|id| reply.answers.contains_key(id))) {
        return Err(refused("form_answers: answer each of the form's fields, and only them".into()));
    }
    let (mut kept, mut lines, mut ids) = (Vec::new(), Vec::new(), Vec::new());
    for field in fields {
        let (id, required) = (field["id"].as_str().unwrap_or_default(), field["required"] == true);
        let label = |option: &str| field["options"].as_array().into_iter().flatten()
            .find(|o| o["id"] == option).map(|o| o["label"].as_str().unwrap_or(option).to_owned());
        let value = &reply.answers[id];
        let wrong = || refused(format!("form_answers: the answer to `{id}` is not one this field takes"));
        // The answer by label, and as its line says it.
        let (answer, said) = match (field["type"].as_str(), value) {
            (Some("text"), Value::String(words)) if words.encode_utf16().count() <= 2000 && (!required || !words.trim().is_empty()) =>
                (json!(words), words.clone()),
            (Some("single"), Value::String(option)) if option.is_empty() && !required => (json!(""), String::new()),
            (Some("single"), Value::String(option)) => {
                let chosen = label(option).ok_or_else(wrong)?;
                (json!(chosen), chosen)
            }
            (Some("multi"), Value::Array(options)) if !(required && options.is_empty()) => {
                let chosen: Vec<&str> = options.iter().filter_map(Value::as_str).collect();
                let distinct: std::collections::HashSet<&str> = chosen.iter().copied().collect();
                if chosen.len() != options.len() || distinct.len() != chosen.len() {
                    return Err(wrong());
                }
                let labels = chosen.iter().map(|option| label(option).ok_or_else(wrong)).collect::<Result<Vec<_>>>()?;
                (json!(labels), labels.join(", "))
            }
            _ => return Err(wrong()),
        };
        let shown_label = field["label"].as_str().unwrap_or(id);
        lines.push(format!("- {shown_label}: {}", if said.is_empty() { "(no answer)" } else { said.as_str() }));
        // JSON.stringify's order: the form's fields.
        ids.push(format!("{}:{value}", Value::from(id)));
        kept.push(json!({"id":id,"label":shown_label,"type":field["type"],"answer":answer}));
    }
    let title = form["title"].as_str().unwrap_or_default();
    let canonical = format!("Answers to \u{201c}{title}\u{201d}:\n{}\n\n{{\"formId\":{},\"answers\":{{{}}}}}",
        lines.join("\n"), Value::from(reply.form_id.as_str()), ids.join(","));
    if text != canonical {
        return Err(refused("form_mismatch: the reply's text does not say these answers".into()));
    }
    Ok(json!({"id":reply.form_id,"title":title,"fields":kept}))
}

/// The option of an ask's reply with this id: (id, label).
pub(super) fn choice(row: &sections::Row, id: &str) -> Option<(String, String)> {
    let reply = &row.data["ask"]["reply"];
    let mut options: Vec<&Value> = reply["options"].as_array().into_iter().flatten().collect();
    options.extend([&reply["choice"]["a"], &reply["choice"]["b"]]);
    options.into_iter().find(|option| option["id"] == id).map(|option| {
        (id.to_owned(), option["label"].as_str().unwrap_or(id).to_owned())
    })
}

/// What a reply says besides its choice. Text that only repeats the chosen
/// label, as older Home windows sent with every pick, adds nothing.
fn extra_text<'a>(choice: Option<&(String, String)>, text: &'a str) -> Option<&'a str> {
    let text = text.trim();
    (!text.is_empty() && choice.is_none_or(|(_, label)| text != label.trim())).then_some(text)
}

/// The message a reply sends: it quotes the section it answers.
pub(super) fn compose(project: &str, section: Option<&sections::Row>, choice: Option<&(String, String)>, text: &str) -> String {
    let Some(row) = section else {
        return format!("Reply from the user on Home, about the Project Brief of {project}:\n\n{}", text.trim());
    };
    let title = row.data["title"].as_str().unwrap_or_default();
    quote(format!("Reply from the user on Home, to the Project Brief section `{}` (\"{title}\") of {project}:\n", row.key), row, choice, text)
}

/// The message a reply to an ask sends (T-9): which version of which ask of
/// which Project of which Workspace it answers, as the user saw it, then
/// what compose quotes and adds. Nothing in it is read from the ask as it is
/// later.
pub(super) fn compose_ask(workspace: &str, project: &str, project_id: &str, row: &sections::Row, choice: Option<&(String, String)>, text: &str) -> String {
    let title = row.data["title"].as_str().unwrap_or_default();
    quote(format!(
        "Reply from the user on Home, to version {} of the Project Brief section `{}` (\"{title}\") of {project} \
         (Workspace {workspace}, Project {project_id}):\n",
        row.version, row.key
    ), row, choice, text)
}

/// `message`, then the section's question (or title) quoted, the choice, the
/// user's own words and, for an ask, how its owner closes it.
fn quote(mut message: String, row: &sections::Row, choice: Option<&(String, String)>, text: &str) -> String {
    let title = row.data["title"].as_str().unwrap_or_default();
    let quoted = row.data["ask"]["question"].as_str().filter(|_| row.kind == "ask").unwrap_or(title);
    let quoted: String = quoted.chars().take(500).collect();
    for line in quoted.lines() {
        message.push_str(&format!("> {line}\n"));
    }
    if let Some((id, label)) = choice {
        message.push_str(&format!("\nChose: {label} ({id})\n"));
    }
    if let Some(text) = extra_text(choice, text) {
        message.push_str(&format!("\n{text}\n"));
    }
    if row.kind == "ask" {
        // How the owner closes it (brief-contract.ts, guide part ask).
        message.push_str(&format!(
            "\nThe ask is now replied and out of the user's Needs you. Act on this reply, then resolve it with brief_update \
             {{op:\"resolve\", key:\"{}\"}}: a preference or information once you have taken it in; an action it authorizes \
             only after that action is done and its result is on the task or the Brief. While it runs, or if it fails, keep \
             the ask replied and report progress there; ask again only if the user has something new to decide. The reply \
             executes nothing by itself: act on what the user has authorized, this reply included, without asking for it \
             again, and infer no retry, merge or wider permission that it does not grant.",
            row.key
        ));
    }
    message.trim_end().to_owned()
}

/// The message a reply to a card sends (T-174): which version of which
/// section of which Project of which Workspace it answers, as the user saw
/// it, then their words. The Workspace is Core's own, never the client's.
/// Nothing in it depends on the section as it is now, so a retry composes the
/// same message after the card has changed.
pub(super) fn compose_card(workspace: &str, project: &str, project_id: &str, key: &str, version: i64, title: &str, text: &str) -> String {
    format!(
        "Reply from the user on Home, to version {version} of the Project Brief section `{key}` (\"{title}\") \
         of {project} (Workspace {workspace}, Project {project_id}):\n\n{}",
        text.trim()
    )
}

/// The Turn a reply joins, as the composer chooses it (App.tsx): Codex
/// steers its running Turn; Claude takes a follow-up only to a running Turn
/// of yours, never to one of its own.
pub(super) fn follow_up_turn(detail: &crate::model::AgentDetail) -> Result<Option<String>> {
    let running = |turn: &&Value| turn["status"] == "inProgress";
    if detail.agent.harness != "claude" {
        return Ok(detail.turns.iter().rev().find(running).and_then(|t| t["id"].as_str()).map(str::to_owned));
    }
    let busy = detail.agent.closed_at.is_none() && matches!(detail.agent.status.as_str(), "working" | "waiting");
    if !busy {
        return Ok(None);
    }
    let yours = detail.turns.iter().rev().filter(running).find(|turn| {
        turn["_yuzunoSource"] != "native" && turn["id"].as_str().is_some_and(|id| !crate::claude::native_turn(id))
    });
    match yours.and_then(|turn| turn["id"].as_str()) {
        Some(id) => Ok(Some(id.into())),
        None => bail!("Claude is working on a turn of its own; wait for it to finish, or interrupt it, then reply"),
    }
}

/// A sent reply marks its ask replied; one not (yet) delivered does not.
pub(super) fn delivered(receipt: &MessageReceipt) -> bool {
    matches!(receipt.status.as_str(), "accepted" | "queued")
}

/// `POST /api/projects/{id}/brief/reply`: one user message to `agentId`,
/// sent as the composer sends it. Returns its receipt.
pub(super) async fn reply(ws: &Arc<Workspace>, project: String, input: ReplyInput) -> Result<MessageReceipt> {
    ensure!(input.text.len() <= MAX_REPLY, "A reply is at most {MAX_REPLY} bytes");
    if let Some(version) = input.version {
        ensure!(input.ask_version.is_none() && input.workspace_id.is_none(), "A reply answers a card or an ask, not both");
        return card_reply(ws, project, input, version).await;
    }
    ensure!(input.title.is_none(), "A title goes with the version of the card it was shown in");
    if let Some(version) = input.ask_version {
        return ask_reply(ws, project, input, version).await;
    }
    ensure!(input.workspace_id.is_none(), "A Workspace goes with the version of the ask it was shown in");
    ensure!(input.form.is_none(), "A form's answers go with the version of the ask it was shown in");
    let (id, key) = (project.clone(), input.key.clone());
    let (workspace, name, section) = ws.stored(move |store| {
        let workspace = store.workspace_id()?;
        let db = store.db.read()?;
        let labels = crate::projects::project_labels(&db)?;
        let (name, _) = labels.get(&id).context("project_not_found: no Project has this ID")?;
        let section = match &key {
            Some(key) => Some(sections::find(&db, &id, key, None)?.context("section_not_found: no such section in this Brief")?),
            None => None,
        };
        Ok((workspace, name.clone(), section))
    }).await?;
    // An ask is answered only as the version the user saw (ask_reply): one
    // from a Home that does not say which is refused, never matched to the
    // ask as it is now.
    if section.as_ref().is_some_and(|row| row.kind == "ask") {
        return Err(not_submitted(
            "ask_version_required: this Home window does not say which version of the ask it showed. Reload Home and reply again; \
             nothing was sent, and your reply is kept.".into(),
        ));
    }
    ensure!(input.choice.is_none(), "A choice answers an ask; name its section");
    ensure!(!input.text.trim().is_empty(), "Write a reply");
    let text = compose(&name, section.as_ref(), None, &input.text);
    let origin = json!({"kind":"home","projectId":project,"key":section.as_ref().map(|row| &row.key),"version":section.as_ref().map(|row| row.version),
        "workspaceId":workspace,"home":snapshot(&name, section.as_ref(), None, None, extra_text(None, &input.text), None)});
    let detail = ws.send_view(&input.agent_id).await?;
    let (agent, client) = (input.agent_id.clone(), input.client_message_id.clone());
    let previous = ws.stored(move |store| store.receipt(&agent, &client)).await?;
    // A retry keeps its first input, whatever Turn is running now.
    let message = match previous {
        Some(previous) if previous.input.text == text => previous.input,
        Some(_) => bail!("This clientMessageId was already used for another message"),
        None => MessageInput {
            client_message_id: input.client_message_id.clone(),
            text,
            text_blocks: None,
            images: vec![],
            expected_turn_id: follow_up_turn(&detail)?,
            question: None,
            clarification: None,
        },
    };
    ws.send_message_from(&input.agent_id, message, Vec::new(), Some(origin)).await
}

/// Refused before anything was recorded: the client keeps its reply, and
/// sending it again is a new message.
fn not_submitted(message: String) -> anyhow::Error {
    anyhow::Error::new(crate::collaboration_credentials::MessageNotSubmitted(anyhow::anyhow!(message)))
}

/// What a reply to an ask says, whatever the ask is now: the option chosen
/// and the user's words, and a form's answers when it sent them, as a digest
/// its receipt keeps (T-9). One without a form digests as it always has.
pub(super) fn reply_digest(choice: Option<&str>, text: &str, form: Option<&FormReply>) -> String {
    use sha2::{Digest, Sha256};
    let said = match form {
        Some(form) => json!([choice, text, {"formId":form.form_id,"answers":form.answers}]),
        None => json!([choice, text]),
    };
    format!("{:x}", Sha256::digest(said.to_string().as_bytes()))
}

/// A reply to an ask (T-9): bound to exactly the version the user saw, in
/// the Workspace whose Home showed it. A version Home no longer has, a
/// resolved or removed ask, or another Workspace sends nothing and says so;
/// the client keeps the reply. A retry of a message already sent under this
/// client id returns its receipt even if the ask changed since. A sent reply
/// marks only that version replied, and only while it is still the live
/// ask: never a newer one its owner asked under the same key.
async fn ask_reply(ws: &Arc<Workspace>, project: String, input: ReplyInput, version: i64) -> Result<MessageReceipt> {
    let key = input.key.clone().context("A reply to an ask names its section")?;
    let (id, wanted) = (project.clone(), key.clone());
    let (workspace, name, current) = ws.stored(move |store| {
        let workspace = store.workspace_id()?;
        let db = store.db.read()?;
        let labels = crate::projects::project_labels(&db)?;
        let (name, _) = labels.get(&id).context("project_not_found: no Project has this ID")?;
        Ok((workspace, name.clone(), sections::find(&db, &id, &wanted, None)?))
    }).await?;
    if input.workspace_id.as_deref() != Some(workspace.as_str()) {
        return Err(not_submitted(
            "workspace_changed: this reply was begun on another Workspace's Home. Nothing was sent, and your reply is kept.".into(),
        ));
    }
    ensure!(input.choice.is_none() || input.form.is_none(), "A reply chooses an option or answers a form, not both");
    let digest = reply_digest(input.choice.as_deref(), &input.text, input.form.as_ref());
    // The ask as it is now, if it is still the version the user saw.
    let shown = current.as_ref().filter(|row| row.live && row.unresolved_ask() && row.version == version).cloned();
    let chosen = match (&input.choice, &shown) {
        (Some(id), Some(row)) => Some(choice(row, id).context("choice_not_found: the ask offers no such option")?),
        _ => None,
    };
    let (agent, client) = (input.agent_id.clone(), input.client_message_id.clone());
    let receipt = if let Some(previous) = ws.stored(move |store| store.receipt(&agent, &client)).await? {
        // The same reply to the same version, sent before: its receipt.
        let same = previous.origin.as_ref().is_some_and(|sent| {
            sent["kind"] == "home" && sent["projectId"] == project && sent["key"] == key
                && sent["version"] == version && sent["reply"] == digest
        });
        ensure!(same, "This clientMessageId was already used for another message");
        ws.send_message(&input.agent_id, previous.input).await?
    } else {
        let Some(row) = &shown else {
            let (code, why) = match &current {
                None => ("section_removed", "it is no longer on Home"),
                Some(row) if row.history_reason.as_deref() == Some("removed") => ("section_removed", "its author removed it"),
                Some(row) if row.kind == "ask" && !row.unresolved_ask() => ("ask_resolved", "its author resolved it"),
                _ => ("ask_changed", "it changed after you began this reply"),
            };
            return Err(not_submitted(format!(
                "{code}: version {version} of the ask `{key}` can't be answered now: {why}. Nothing was sent, and your reply is kept."
            )));
        };
        ensure!(!input.text.trim().is_empty() || chosen.is_some(), "Write a reply or choose an option");
        let form = input.form.as_ref().map(|form| form_answers(row, form, &input.text)).transpose()?;
        let origin = json!({"kind":"home","projectId":project,"key":key,"version":version,"workspaceId":workspace,"reply":digest,
            "home":snapshot(&name, Some(row), None, chosen.as_ref(), extra_text(chosen.as_ref(), &input.text).filter(|_| form.is_none()), form)});
        let detail = ws.send_view(&input.agent_id).await?;
        let message = MessageInput {
            client_message_id: input.client_message_id.clone(),
            text: compose_ask(&workspace, &name, &project, row, chosen.as_ref(), &input.text),
            text_blocks: None,
            images: vec![],
            expected_turn_id: follow_up_turn(&detail)?,
            question: None,
            clarification: None,
        };
        ws.send_message_from(&input.agent_id, message, Vec::new(), Some(origin)).await?
    };
    // Marked on that version only, if it is still the live ask now.
    if shown.is_some() && delivered(&receipt) {
        let reply = match (&chosen, extra_text(chosen.as_ref(), &input.text)) {
            (Some((_, label)), None) => label.clone(),
            (Some((_, label)), Some(text)) => format!("{label}: {text}"),
            (None, text) => text.unwrap_or_default().to_owned(),
        };
        let reply: String = reply.chars().take(2000).collect();
        let (store, key, id) = (ws.store.clone(), key.clone(), project.clone());
        if crate::db::blocking(move || sections::mark_replied(&store, &id, &key, version, &reply)).await? {
            announce(ws, Some(&project));
        }
    }
    Ok(receipt)
}

/// A reply to a report or status card (T-174): bound to exactly the version
/// the user saw, never to a newer one or to another card, and it changes no
/// ask, task or Seen mark. A retry of a message already sent returns its
/// receipt even if the card has changed since; otherwise a version Home no
/// longer has, or a removed card, sends nothing and says so.
async fn card_reply(ws: &Arc<Workspace>, project: String, input: ReplyInput, version: i64) -> Result<MessageReceipt> {
    let key = input.key.clone().context("A reply to a card names its section")?;
    let title = input.title.clone().context("A reply to a card says the title it showed")?;
    ensure!(input.choice.is_none() && input.form.is_none(), "A choice or a form answers an ask, not a card");
    ensure!(!input.text.trim().is_empty(), "Write a reply");
    let (id, wanted) = (project.clone(), key.clone());
    let (workspace, name, shown) = ws.stored(move |store| {
        let workspace = store.workspace_id()?;
        let db = store.db.read()?;
        let labels = crate::projects::project_labels(&db)?;
        let (name, _) = labels.get(&id).context("project_not_found: no Project has this ID")?;
        Ok((workspace, name.clone(), sections::find(&db, &id, &wanted, Some(version))?))
    }).await?;
    let text = compose_card(&workspace, &name, &project, &key, version, &title, &input.text);
    let detail = ws.send_view(&input.agent_id).await?;
    let (agent, client) = (input.agent_id.clone(), input.client_message_id.clone());
    if let Some(previous) = ws.stored(move |store| store.receipt(&agent, &client)).await? {
        ensure!(previous.input.text == text, "This clientMessageId was already used for another message");
        return ws.send_message(&input.agent_id, previous.input).await;
    }
    let refused = |message: String| anyhow::Error::new(crate::collaboration_credentials::MessageNotSubmitted(anyhow::anyhow!(message)));
    let Some(row) = shown else {
        return Err(refused(format!(
            "section_changed: version {version} of “{title}” is no longer on Home; it changed after you began this reply. \
             Nothing was sent, and your reply is kept."
        )));
    };
    if row.history_reason.as_deref() == Some("removed") {
        return Err(refused(format!("section_removed: its author removed “{title}”. Nothing was sent, and your reply is kept.")));
    }
    if row.kind == "ask" || row.data["title"].as_str() != Some(title.as_str()) {
        return Err(refused(format!("section_changed: version {version} of `{key}` is not the card “{title}”. Nothing was sent.")));
    }
    let origin = json!({"kind":"home","projectId":project,"key":key,"version":version,"workspaceId":workspace,
        "home":snapshot(&name, Some(&row), Some(&title), None, extra_text(None, &input.text), None)});
    let message = MessageInput {
        client_message_id: input.client_message_id,
        text,
        text_blocks: None,
        images: vec![],
        expected_turn_id: follow_up_turn(&detail)?,
        question: None,
        clarification: None,
    };
    ws.send_message_from(&input.agent_id, message, Vec::new(), Some(origin)).await
}
