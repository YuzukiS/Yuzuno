//! Home (GET /api/home): every Project's Brief beside the facts Core holds
//! about it (its Agents, their requests and errors, its Jobs), and the
//! "needs you" strip across Projects. Project Priority only orders this
//! view; it never changes scheduling.
use super::{cards, sections, *};
use crate::model::{Agent, MessageInput, MessageReceipt, PendingRequest};
use chrono::{DateTime, Utc};
use std::collections::{hash_map::Entry, HashMap};

const ORDER_KEY: &str = "home.projectOrder";
/// The longest reply Home sends, in UTF-8 bytes, the unit Core counts a
/// message in and Home's page counts too (web/src/home/reply-limit.tsx, which
/// says the same number; YN-91). A reply goes to its Agent as one message,
/// under the limit any message has, a conversation's included
/// (MAX_MESSAGE_TEXT), with Core's quote of the card or ask it answers
/// before it: QUOTE_ROOM is kept for that quote, and the longest one Brief
/// sections allow fits in it (tests.rs, the_longest_quote_fits_beside_the_longest_reply).
pub(crate) const MAX_REPLY: usize = 92_000;
pub(super) const QUOTE_ROOM: usize = crate::model::MAX_MESSAGE_TEXT - MAX_REPLY;

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
    // Claude's AskUserQuestion and Bash name them under `input` (T-42).
    params["reason"].as_str()
        .or_else(|| params["command"].as_str())
        .or_else(|| params["input"]["command"].as_str())
        .or_else(|| params["questions"][0]["question"].as_str())
        .or_else(|| params["input"]["questions"][0]["question"].as_str())
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
        let mut data: Value = serde_json::from_str(&data)?;
        // The key its task has now, not the one stored when it was submitted (T-56).
        crate::task_keys::refresh(db, &mut data);
        // Its Agent's name now (a rename shows at once, YN-112); the one the
        // Job kept only when that Agent is gone, as machine_load.rs does.
        let name = agents.get(&agent).map(|a| a.name.clone()).or_else(|| data["agent"]["name"].as_str().map(str::to_owned));
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

/// The Needs you item of an executor the user dispatched, when its result
/// waits for the user's release (`delivering`), its start failed (`failed`),
/// or its task is blocked while it runs (`blocked`): the lifecycle the Agent
/// listing carries (executor_lifecycle.rs).
pub(crate) fn executor_need(agent: &Agent) -> Option<Value> {
    let lifecycle = agent.executor.as_ref()?;
    if lifecycle["dispatcher"]["kind"] != "user" {
        return None;
    }
    let state = match lifecycle["state"].as_str()? {
        "delivering" => "delivering",
        "failed" => "failed",
        "running" | "starting" | "queued" if lifecycle["blocked"].is_string() => "blocked",
        _ => return None,
    };
    let title = lifecycle["task"]["title"].as_str().unwrap_or_default().chars().take(200).collect::<String>();
    let since = lifecycle["since"].as_str().map(str::to_owned).unwrap_or_else(|| agent.updated_at.clone());
    Some(json!({"kind":"executor","projectId":agent.project_id,"agentId":agent.id,"agentName":agent.name,
        "state":state,"taskId":lifecycle["task"]["id"],"title":title,"reason":lifecycle["reason"].as_str().or(lifecycle["blocked"].as_str()),
        "since":since}))
}

/// How Home's history comes (YN-221 S1): whole, as always, or as an index a
/// newer page asks for (`GET /api/home?history=index`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum History {
    Full,
    /// Every entry of the same history, in the same order, without its
    /// body, attachments and refs: `bodyOmitted: true` and
    /// `attachmentCount` instead. The page reads the entries it shows whole
    /// with `history_entries`.
    Index,
}

/// The Agents and the requests and questions that wait on them, as Home and
/// Needs you read them.
struct Waiting<'a> {
    agents: &'a [Agent],
    by_id: &'a HashMap<String, Agent>,
    pending: HashMap<&'a str, Vec<PendingRequest>>,
    questions: HashMap<&'a str, Vec<crate::record_rows::OpenQuestion>>,
}

impl<'a> Waiting<'a> {
    fn read(store: &Store, agents: &'a [Agent], by_id: &'a HashMap<String, Agent>) -> Self {
        // Only the requests of Agents with requests waiting, not their records:
        // Home is rebuilt on every change while one waits (T-120).
        let mut pending: HashMap<&str, Vec<PendingRequest>> = HashMap::new();
        for agent in agents.iter().filter(|a| a.closed_at.is_none() && a.native_requests() > 0) {
            match store.pending(&agent.id) {
                Ok(requests) => {
                    pending.insert(agent.id.as_str(), requests);
                }
                Err(error) => eprintln!("Home skipped the requests of Agent {}: {error:#}", agent.id),
            }
        }
        // And the questions they sent to be answered later (T-42).
        let mut questions: HashMap<&str, Vec<crate::record_rows::OpenQuestion>> = HashMap::new();
        for agent in agents.iter().filter(|a| a.closed_at.is_none() && a.open_questions > 0) {
            match store.open_questions(&agent.id) {
                Ok(open) => {
                    questions.insert(agent.id.as_str(), open);
                }
                Err(error) => eprintln!("Home skipped the questions of Agent {}: {error:#}", agent.id),
            }
        }
        Self { agents, by_id, pending, questions }
    }

    /// The section's owner as Home names it.
    fn owner(&self, row: &sections::Row) -> sections::Owner {
        let agent = self.by_id.get(&row.owner_id).map(|a| sections::OwnerAgent {
            closed: a.closed_at.is_some(), name: a.name.as_str(), project: a.project_id.as_deref() });
        sections::owner(agent, row)
    }

    /// Needs you: requests and questions, the user's executors that wait on
    /// the user, and each Project's open asks not deferred, by Project
    /// Priority, then the longest wait first.
    fn needs_you(&self, db: &Connection, projects: &[crate::projects::Project], order: &[String], at: DateTime<Utc>) -> Result<Vec<Value>> {
        let rank: HashMap<&str, usize> = order.iter().enumerate().map(|(i, id)| (id.as_str(), i)).collect();
        let mut needs: Vec<(usize, Option<DateTime<Utc>>, Value)> = vec![];
        for agent in self.agents.iter().filter(|a| a.closed_at.is_none()) {
            for request in self.pending.get(agent.id.as_str()).into_iter().flatten() {
                let priority = agent.project_id.as_deref().and_then(|id| rank.get(id)).copied().unwrap_or(usize::MAX);
                needs.push((priority, time(&request.created_at), json!({"kind":"approval","projectId":agent.project_id,
                    "agentId":agent.id,"agentName":agent.name,"requestId":request.id,"title":request_title(request),
                    "since":request.created_at})));
            }
            for question in self.questions.get(agent.id.as_str()).into_iter().flatten() {
                let priority = agent.project_id.as_deref().and_then(|id| rank.get(id)).copied().unwrap_or(usize::MAX);
                let since = question.at_ms.and_then(DateTime::<Utc>::from_timestamp_millis);
                let title: String = question.title.as_deref().unwrap_or("Answer when you can").chars().take(200).collect();
                needs.push((priority, since, json!({"kind":"question","projectId":agent.project_id,"agentId":agent.id,
                    "agentName":agent.name,"turnId":question.turn_id,"itemId":question.item_id,"title":title,
                    "since":since.map(|at| at.to_rfc3339())})));
            }
        }
        // An executor the user dispatched whose result waits for the user's
        // release, or whose start failed or task is blocked (T-36 S3). A lead's
        // executors are that lead's to follow, never listed here.
        for agent in self.agents {
            if let Some(item) = executor_need(agent) {
                let priority = agent.project_id.as_deref().and_then(|id| rank.get(id)).copied().unwrap_or(usize::MAX);
                let since = item["since"].as_str().and_then(time);
                needs.push((priority, since, item));
            }
        }
        for (priority, id) in order.iter().enumerate() {
            if !projects.iter().any(|p| &p.id == id) {
                continue;
            }
            // Only their title and gate are read (sections::open_asks).
            for row in sections::open_asks(db, id)? {
                if row.deferred_until.as_deref().and_then(time).is_some_and(|until| until > at) {
                    continue;
                }
                let since = row.ask_since.clone().unwrap_or_else(|| row.updated_at.clone());
                let mut item = json!({"kind":"ask","projectId":id,"agentId":row.owner_id,
                    "agentName":self.owner(&row).name,"sectionKey":row.key,"title":row.data["title"],"since":since});
                // An executor's gate (T-43 S4): the rail shows its executor waiting for you.
                if row.data["ask"]["gate"].is_object() {
                    item["gate"] = row.data["ask"]["gate"].clone();
                }
                needs.push((priority, time(&since), item));
            }
        }
        // By Project Priority, then the longest wait first.
        needs.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
        Ok(needs.into_iter().map(|n| n.2).collect())
    }
}

/// What Home shows of one Project's sections beside each one's own row: the
/// user's marks and notes, its leads and its cards' refreshes. `build` and
/// `history_entries` show a section through the same `section`, so an entry
/// read alone is the one Home's history has.
struct Shown<'a> {
    db: &'a Connection,
    waiting: &'a Waiting<'a>,
    project: &'a str,
    /// The Project's name, as a reply's snapshot names it.
    name: &'a str,
    /// Each answered ask's reply as the user gave it (YN-223), of the rows it is read for (sections::KeptRows).
    kept: HashMap<i64, sections::KeptReply>,
    policy: editors::Policy,
    seen: HashMap<String, (i64, String)>,
    opened: HashMap<i64, (i64, String)>,
    notes: HashMap<i64, Vec<Value>>,
    refreshes: HashMap<i64, Value>,
    at: DateTime<Utc>,
}

impl<'a> Shown<'a> {
    fn read(db: &'a Connection, waiting: &'a Waiting<'a>, project: &'a str, name: &'a str, kept: sections::KeptRows,
        at: DateTime<Utc>) -> Result<Self> {
        let agent_name = |agent: &str| waiting.by_id.get(agent).map(|a| a.name.clone());
        Ok(Self {
            db,
            waiting,
            project,
            name,
            kept: sections::kept_replies(db, project, kept)?,
            policy: editors::policy(db, project)?,
            seen: sections::seen(db, project)?,
            opened: sections::opened(db, project)?,
            // The user's notes on each ask (YN-213), apart from its reply.
            notes: super::ask_notes::of_project(db, project)?,
            // A card's refresh (YN-113), on the one entry Home shows of its
            // identity: the live section, else its newest history entry.
            refreshes: super::refresh::shown(db, project, &agent_name, at)?,
            at,
        })
    }

    /// A source filter, never a Seen mark or deletion. All Asks remain
    /// reachable, including a subtopic whose regular parent is hidden.
    /// A lead's (YN-2 S4), a sub-topic its card's executor wrote under
    /// it (YN-86 S2a), and a topic's own section bound to a task by its
    /// own `task`, whoever wrote it (YN-212 C1): the others' are in the
    /// team sections.
    fn current(&self, row: &sections::Row) -> Result<bool> {
        Ok(row.kind == "ask" || self.policy.includes(&row.owner_id) || cards::on_card(self.db, row)? || cards::bound_topic(row))
    }

    /// One section as Home shows it; `refresh` puts its card's refresh on
    /// it. `index`: a row of `sections::history_index`, shown without body,
    /// attachments and refs.
    fn section(&self, row: &sections::Row, refs: &mut super::refs::Refs, cards: &mut cards::Cards, refresh: bool, index: bool) -> Result<Value> {
        let found = if index { Value::Null } else { refs.of(&row.data["body"]) };
        let mut section = sections::section_json(row, &self.waiting.owner(row), self.seen.get(&row.key), found, self.at);
        crate::project_requests::show_opened(self.db, self.project, row.identity, &mut section)?;
        // id is the section's identity on Home: the same through every put
        // and edit of it, and through a report the user marked seen that its
        // owner then writes again; a section removed and written again has
        // a new one, so a widget pinned to the old one never shows it.
        section["id"] = json!(row.identity);
        // The task it is the card of and who answers for it (YN-86 S2a).
        cards::show(&mut section, cards.of(row)?);
        cards::mark_placeholder(self.db, row, &mut section)?;
        // The newest version the user's browser showed whole (YN-86):
        // apart from `seen`, which a report's Seen mark sets.
        if row.live {
            section["opened"] = self.opened.get(&row.identity).map(|(version, at)| json!({"version":version,"at":at})).into();
            if let Some(notes) = self.notes.get(&row.identity).filter(|_| row.kind == "ask") {
                section["ask"]["notes"] = json!(notes);
            }
        }
        // A history entry says why it is history and whether its source is
        // one Home shows now (the same test as `current`).
        if !row.live {
            section["historyReason"] = json!(row.history_reason);
            section["currentSource"] = json!(self.current(row)?);
        }
        // An answered ask's reply as the user gave it (YN-223): replied, or resolved in History. Never on an index
        // entry: it comes with the entry read whole.
        if let Some(snapshot) = self.kept.get(&row.seq).filter(|_| !index).and_then(|kept| answered(row, self.name, kept)) {
            section["ask"]["replySnapshot"] = snapshot;
        }
        if let Some(found) = self.refreshes.get(&row.identity).filter(|_| refresh) {
            section["refresh"] = found.clone();
        }
        // A task's card's earlier versions (YN-212 C2), only when it has any.
        if cards::task_card(row) {
            let revisions = sections::revisions(self.db, self.project, row.identity)?;
            if !revisions.is_empty() {
                section["revisions"] = json!(revisions);
            }
        }
        if index {
            if let Some(fields) = section.as_object_mut() {
                for field in ["body", "attachments", "refs"] {
                    fields.remove(field);
                }
            }
            section["bodyOmitted"] = json!(true);
            section["attachmentCount"] = row.data["attachmentCount"].clone();
        }
        Ok(section)
    }
}

/// The HomeData of web/src/home/types.ts.
pub(super) fn build(store: &Store) -> Result<Value> {
    build_with(store, History::Full)
}

/// The HomeData, its history whole or as an index.
pub(super) fn build_with(store: &Store, history: History) -> Result<Value> {
    let at = Utc::now();
    // Each of these takes its own reader; the Briefs are read on one after.
    let agents = store.agents()?;
    let by_id: HashMap<String, Agent> = agents.iter().map(|a| (a.id.clone(), a.clone())).collect();
    let waiting = Waiting::read(store, &agents, &by_id);
    let projects = store.projects()?;
    let order = effective(&projects, &stored_order(store)?);
    let db = store.db.read()?;
    let mut refs = super::refs::Refs::new(store, &db);
    let mut cards = cards::Cards::new(&db);
    let jobs = live_jobs(&db, &by_id)?;
    let needs = waiting.needs_you(&db, &projects, &order, at)?;
    let mut panels = vec![];
    for id in &order {
        let Some(project) = projects.iter().find(|p| &p.id == id) else { continue };
        let members: Vec<&Agent> = agents.iter().filter(|a| a.closed_at.is_none() && a.project_id.as_deref() == Some(id)).collect();
        let errors: Vec<Value> = members.iter().filter_map(|a| {
            a.error.as_ref().map(|message| json!({"agentId":a.id,"agentName":a.name,"message":message,"at":a.updated_at}))
        }).collect();
        let mut requests = vec![];
        for agent in &members {
            for request in waiting.pending.get(agent.id.as_str()).into_iter().flatten() {
                let mut shown = serde_json::to_value(request)?;
                shown["agentName"] = json!(agent.name);
                requests.push(shown);
            }
        }
        let live = sections::live(&db, id)?;
        // The index reads the replies kept for the live sections only: History's come with its entries (YN-223).
        let kept = match history {
            History::Full => sections::KeptRows::Every,
            History::Index => sections::KeptRows::Live,
        };
        let view = Shown::read(&db, &waiting, id, &project.name, kept, at)?;
        let mut visible = vec![];
        for row in &live {
            if view.current(row)? {
                visible.push(row.clone());
            }
        }
        let team: Vec<_> = live.iter().filter(|row| !visible.iter().any(|shown| shown.key == row.key)).cloned().collect();
        let history_rows = match history {
            History::Full => sections::history(&db, id)?,
            History::Index => sections::history_index(&db, id)?,
        };
        let mut refreshed = std::collections::HashSet::new();
        let mut shown = |rows: &[sections::Row], index: bool| -> Result<Vec<Value>> {
            rows.iter().map(|row| {
                let refresh = view.refreshes.contains_key(&row.identity) && refreshed.insert(row.identity);
                view.section(row, &mut refs, &mut cards, refresh, index)
            }).collect()
        };
        let mut brief = json!({"version":sections::brief_version(&db, id)?,"sections":shown(&visible, false)?,
            "teamSections":shown(&team, false)?,"history":shown(&history_rows, history == History::Index)?});
        if history == History::Index {
            brief["historyIndex"] = json!(true);
        }
        panels.push(json!({
            "project":{"id":project.id,"name":project.name},
            "agents":counts(&members),
            "errors":errors,
            "pending":requests,
            "jobs":jobs.iter().filter(|job| job.project.as_deref() == Some(id)).map(|job| job.shown.clone()).collect::<Vec<_>>(),
            "contentEditors":view.policy,
            "brief":brief,
            "unseen":sections::unseen(&visible, &view.seen, &view.opened),
            "missing":missing(store, &db, id, &by_id)?,
        }));
    }
    Ok(json!({"generatedAt":now(),"order":order,"needsYou":needs,"projects":panels}))
}

/// At most this many entries in one `history_entries` read: each is a whole
/// section, body included (the Seen mark's batch is 200 index entries).
pub(super) const ENTRIES_AT_ONCE: usize = 50;

/// The entries of one Project's Home history with these identities and
/// versions, each exactly as `build`'s full history shows it, and the pairs
/// that are no entry of it now (`missing`): expired, a live section, a
/// card's past issue or earlier version, or another Project's (YN-221 S1).
pub(super) fn history_entries(store: &Store, project: &str, wanted: &[(i64, i64)]) -> Result<Value> {
    ensure!(wanted.len() <= ENTRIES_AT_ONCE, "invalid_input: at most {ENTRIES_AT_ONCE} entries at once");
    let at = Utc::now();
    let agents = store.agents()?;
    let by_id: HashMap<String, Agent> = agents.iter().map(|a| (a.id.clone(), a.clone())).collect();
    // Home's history shows no requests or questions: none are read.
    let waiting = Waiting { agents: &agents, by_id: &by_id, pending: HashMap::new(), questions: HashMap::new() };
    let db = store.db.read()?;
    let projects = store.projects()?;
    let shown_project = projects.iter().find(|p| p.id == project && p.archived_at.is_none());
    let rows = if shown_project.is_some() { sections::history_entries(&db, project, wanted)? } else { vec![] };
    let mut entries = vec![];
    if let Some(shown_project) = shown_project.filter(|_| !rows.is_empty()) {
        // The replies kept for these entries only (YN-223).
        let seqs: Vec<i64> = rows.iter().map(|row| row.seq).collect();
        let view = Shown::read(&db, &waiting, project, &shown_project.name, sections::KeptRows::Rows(&seqs), at)?;
        let mut refs = super::refs::Refs::new(store, &db);
        let mut cards = cards::Cards::new(&db);
        // A card's refresh is on its live section, else on its identity's
        // first entry in history's order, as `build` puts it.
        let live = sections::live_identities(&db, project)?;
        let mut first = HashMap::new();
        for (seq, identity) in sections::history_order(&db, project)? {
            first.entry(identity).or_insert(seq);
        }
        for row in &rows {
            let refresh = !live.contains(&row.identity) && first.get(&row.identity) == Some(&row.seq);
            entries.push(view.section(row, &mut refs, &mut cards, refresh, false)?);
        }
    }
    let missing: Vec<Value> = wanted.iter()
        .filter(|(id, version)| !rows.iter().any(|row| row.identity == *id && row.version == *version))
        .map(|(id, version)| json!({"id":id,"version":version}))
        .collect();
    Ok(json!({"entries":entries,"missing":missing}))
}

/// Needs you alone (`GET /api/home/needs`, YN-221 S1): the same items as
/// `build`'s, without reading a Brief's sections whole.
pub(super) fn needs(store: &Store) -> Result<Value> {
    let at = Utc::now();
    let agents = store.agents()?;
    let by_id: HashMap<String, Agent> = agents.iter().map(|a| (a.id.clone(), a.clone())).collect();
    let waiting = Waiting::read(store, &agents, &by_id);
    let projects = store.projects()?;
    let order = effective(&projects, &stored_order(store)?);
    let db = store.db.read()?;
    Ok(json!({"generatedAt":now(),"needsYou":waiting.needs_you(&db, &projects, &order, at)?}))
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
    /// Images the user attached on Home (YN-134), by their IDs in the
    /// Project's images written on Home (input_images::home_dir). Once the
    /// recipient is known they are copied to it (`adopt_images`) and go
    /// with the message, as a conversation's do; beside a form's answers
    /// too (YN-213).
    #[serde(default)]
    pub images: Vec<String>,
    /// Files the user attached on Home (YN-145), by their references in the
    /// Project's files written on Home (input_files::home_dir). Once the
    /// recipient is known they are copied to it (`adopt_files`) and go with
    /// the message; beside a form's answers too (YN-213).
    #[serde(default)]
    pub files: Vec<crate::input_files::FileRef>,
    /// What a reply to an ask is (YN-213): an answer, as every reply was
    /// before, or a note.
    #[serde(default)]
    pub intent: ReplyIntent,
    /// The user's own words beside a form's answers (YN-213): `text` says
    /// the answers exactly (form_answers), and these follow them in the same
    /// message and on the answered ask. Only with a form: beside a choice,
    /// and in a note, `text` is the user's words.
    #[serde(default)]
    pub note: Option<String>,
}

/// What a reply to an ask is (YN-213).
#[derive(serde::Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum ReplyIntent {
    /// It answers the ask: its choice, its form's answers or the user's
    /// words, and the ask is replied once it is delivered.
    #[default]
    Answer,
    /// Home's "Wait, what?": the user's words, images and files to the
    /// ask's Agent without answering it. No choice or form goes with it,
    /// the ask stays open in Needs you at the version it was written on,
    /// and Core keeps the note apart from any reply (ask_notes).
    Note,
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
        // The answer by label, and as its line says it. Words of any length
        // (YN-103): the reply they are in is at most MAX_REPLY bytes (`reply`).
        let (answer, said) = match (field["type"].as_str(), value) {
            (Some("text"), Value::String(words)) if !required || !words.trim().is_empty() =>
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
        let mut answered = json!({"id":id,"label":shown_label,"type":field["type"],"answer":answer});
        // A choice's options as this version offered them (YN-230): what the user did not choose, beside what they did.
        if let Some(options) = offered(field) {
            answered["options"] = options;
        }
        kept.push(answered);
    }
    let title = form["title"].as_str().unwrap_or_default();
    let canonical = format!("Answers to \u{201c}{title}\u{201d}:\n{}\n\n{{\"formId\":{},\"answers\":{{{}}}}}",
        lines.join("\n"), Value::from(reply.form_id.as_str()), ids.join(","));
    if text != canonical {
        return Err(refused("form_mismatch: the reply's text does not say these answers".into()));
    }
    Ok(json!({"id":reply.form_id,"title":title,"fields":kept}))
}

/// A choice field's options by label, in its order, as `form_answers` reads an option's label; none for words.
fn offered(field: &Value) -> Option<Value> {
    if !matches!(field["type"].as_str(), Some("single" | "multi")) {
        return None;
    }
    let options = field["options"].as_array().into_iter().flatten();
    Some(json!(options.filter_map(|o| o["label"].as_str().or(o["id"].as_str())).collect::<Vec<_>>()))
}

/// An answered ask's reply as the user gave it to the version it answers (YN-223): the snapshot Core kept with it; or,
/// for a form reply from before Core kept one, the answers it kept by id (YN-74, reply_form) read as that very
/// version's form labels them, only while the ask is still that version and the reply's text says exactly those
/// answers (form_answers), so nothing is guessed: a note beside them, or any other text, leaves the reply as sent.
fn answered(row: &sections::Row, project: &str, kept: &sections::KeptReply) -> Option<Value> {
    if row.kind != "ask" || !matches!(row.ask_state.as_deref(), Some("replied" | "resolved")) {
        return None;
    }
    if let Some(snapshot) = &kept.snapshot {
        return Some(with_options(snapshot.clone(), row, kept));
    }
    let form = kept.form.as_ref().filter(|form| row.replied_ask() && form["version"].as_i64() == Some(row.version))?;
    let reply: FormReply = serde_json::from_value(json!({"formId": form["formId"], "answers": form["answers"]})).ok()?;
    let answers = form_answers(row, &reply, row.reply_text.as_deref()?).ok()?;
    Some(snapshot(project, Some(row), None, None, None, Some(answers)))
}

/// A snapshot kept before Core kept a form's choice options with it (YN-230): each choice field without them gets the
/// options of the very version answered, the version its answers by id were kept with (reply_form), while the ask is
/// still that version and its form is the one answered (same form, field, kind and label). Otherwise (another version,
/// even of a form with the same id, or a reply that kept no answers by id) its fields stay as kept: only the answers.
fn with_options(mut snapshot: Value, row: &sections::Row, kept: &sections::KeptReply) -> Value {
    let form = &row.data["ask"]["reply"]["form"];
    let same = kept.form.as_ref().is_some_and(|by_id| by_id["version"].as_i64() == Some(row.version) && by_id["formId"] == form["id"]);
    if !same || snapshot["form"]["id"] != form["id"] {
        return snapshot;
    }
    let fields = form["fields"].as_array().map(Vec::as_slice).unwrap_or_default();
    for field in snapshot["form"]["fields"].as_array_mut().into_iter().flatten() {
        if field.get("options").is_some() {
            continue;
        }
        let asked = fields.iter().find(|f| f["id"] == field["id"] && f["type"] == field["type"] && f["label"].as_str().unwrap_or(f["id"].as_str().unwrap_or_default()) == field["label"]);
        if let Some(options) = asked.and_then(offered) {
            field["options"] = options;
        }
    }
    snapshot
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
    quote(format!("Reply from the user on Home, to the Project Brief section `{}` (\"{title}\") of {project}:\n", row.key), row, choice, text, None)
}

/// The message a reply to an ask sends (T-9): which version of which ask of
/// which Project of which Workspace it answers, as the user saw it, then
/// what compose quotes and adds. Nothing in it is read from the ask as it is
/// later.
pub(super) fn compose_ask(workspace: &str, project: &str, project_id: &str, row: &sections::Row, choice: Option<&(String, String)>, text: &str) -> String {
    compose_answer(workspace, project, project_id, row, choice, text, None)
}

/// `compose_ask` with the user's note beside a form's answers (YN-213),
/// after them.
pub(super) fn compose_answer(workspace: &str, project: &str, project_id: &str, row: &sections::Row, choice: Option<&(String, String)>,
    text: &str, note: Option<&str>) -> String {
    let title = row.data["title"].as_str().unwrap_or_default();
    quote(format!(
        "Reply from the user on Home, to version {} of the Project Brief section `{}` (\"{title}\") of {project} \
         (Workspace {workspace}, Project {project_id}):\n",
        row.version, row.key
    ), row, choice, text, note)
}

/// The message a note on an ask sends (YN-213, Home's "Wait, what?"):
/// which version of which ask it is about, as the user saw it, the user's
/// words, and that it answers nothing. Nothing in it is read from the ask as
/// it is later.
pub(super) fn compose_note(workspace: &str, project: &str, project_id: &str, row: &sections::Row, text: &str) -> String {
    let title = row.data["title"].as_str().unwrap_or_default();
    let mut message = format!(
        "Note from the user on Home, about version {} of the Project Brief section `{}` (\"{title}\") of {project} \
         (Workspace {workspace}, Project {project_id}):\n",
        row.version, row.key
    );
    quote_question(&mut message, row);
    match text.trim() {
        "" => message.push_str("\n(No words: see what the note attached.)\n"),
        text => message.push_str(&format!("\n{text}\n")),
    }
    // Where the ask stays, as it is now: a note changes nothing of it (an answered ask stays answered).
    let stays = if row.replied_ask() {
        format!("The ask stays as it was at version {}: replied, with the answer they gave before, which this note does not change.", row.version)
    } else {
        format!("The ask stays open in their Needs you at version {}, with what they had begun to answer kept there.", row.version)
    };
    message.push_str(&format!(
        "\nThis note is not an answer: the user chose none of the ask's options, answered nothing of its form and approved \
         nothing. {stays} Take the note as a question or a remark about the ask: answer it by revising the ask (edit or put it), \
         or resolve or remove the ask if it no longer applies. Act on none of its options as chosen."
    ));
    message
}

/// The section's question (or title) quoted, one `> ` line each.
fn quote_question(message: &mut String, row: &sections::Row) {
    let title = row.data["title"].as_str().unwrap_or_default();
    let quoted = row.data["ask"]["question"].as_str().filter(|_| row.kind == "ask").unwrap_or(title);
    let quoted: String = quoted.chars().take(500).collect();
    for line in quoted.lines() {
        message.push_str(&format!("> {line}\n"));
    }
}

/// `message`, then the section's question (or title) quoted, the choice, the
/// user's own words, their note beside a form's answers and, for an ask, how
/// its owner closes it.
fn quote(mut message: String, row: &sections::Row, choice: Option<&(String, String)>, text: &str, note: Option<&str>) -> String {
    quote_question(&mut message, row);
    if let Some((id, label)) = choice {
        message.push_str(&format!("\nChose: {label} ({id})\n"));
    }
    if let Some(text) = extra_text(choice, text) {
        message.push_str(&format!("\n{text}\n"));
    }
    if let Some(note) = note.map(str::trim).filter(|note| !note.is_empty()) {
        message.push_str(&format!("\nWith these answers, the user wrote:\n{note}\n"));
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
    compose_bound_card(workspace, project, project_id, key, version, title, None, text)
}

/// `compose_card` for the responsible Agent of a card bound to task `bound`
/// (YN-86 S2a): one more line says so, before the user's words.
#[allow(clippy::too_many_arguments)]
pub(super) fn compose_bound_card(workspace: &str, project: &str, project_id: &str, key: &str, version: i64, title: &str,
    bound: Option<&str>, text: &str) -> String {
    let head = card_head(workspace, project, project_id, key, version, title);
    match bound {
        Some(task) => format!("{head}\n{BOUND}{task}{RESPONSIBLE}\n\n{}", text.trim()),
        None => format!("{head}\n\n{}", text.trim()),
    }
}

/// What a card reply's message says before the user's words.
pub(super) fn card_head(workspace: &str, project: &str, project_id: &str, key: &str, version: i64, title: &str) -> String {
    format!(
        "Reply from the user on Home, to version {version} of the Project Brief section `{key}` (\"{title}\") \
         of {project} (Workspace {workspace}, Project {project_id}):"
    )
}

const BOUND: &str = "This card is bound to task ";
const RESPONSIBLE: &str = "; you are its responsible Agent.";

/// Whether `sent`, the message already sent under a card reply's client ID,
/// is this reply (`head` and the user's `text`): without the line naming
/// its task or with it, whichever task it named, since the binding and who
/// answers for it may have changed since and a retry still finds its message.
pub(super) fn same_card_reply(sent: &str, head: &str, text: &str) -> bool {
    let Some(line) = sent.strip_prefix(head).and_then(|rest| rest.strip_suffix(text.trim())).and_then(|rest| rest.strip_suffix("\n\n")) else {
        return false;
    };
    line.is_empty()
        || line.strip_prefix('\n').and_then(|line| line.strip_prefix(BOUND)).and_then(|line| line.strip_suffix(RESPONSIBLE))
            .is_some_and(|task| !task.is_empty() && !task.contains('\n'))
}

/// The Turn a reply joins, as the composer chooses it (App.tsx): the newest
/// running Turn. Claude takes it while it works, whether the Turn is yours
/// or one of its own (T-45).
pub(crate) fn follow_up_turn(detail: &crate::model::AgentDetail) -> Option<String> {
    let busy = detail.agent.closed_at.is_none() && matches!(detail.agent.status.as_str(), "working" | "waiting");
    if detail.agent.harness == "claude" && !busy {
        return None;
    }
    detail.turns.iter().rev().find(|turn| turn["status"] == "inProgress").and_then(|t| t["id"].as_str()).map(str::to_owned)
}

/// A sent reply marks its ask replied; one not (yet) delivered does not.
pub(super) fn delivered(receipt: &MessageReceipt) -> bool {
    matches!(receipt.status.as_str(), "accepted" | "queued")
}

/// `POST /api/projects/{id}/brief/reply`: one user message to `agentId`,
/// sent as the composer sends it. Returns its receipt.
pub(super) async fn reply(ws: &Arc<Workspace>, project: String, input: ReplyInput) -> Result<MessageReceipt> {
    // A form's note goes in the same message as its answers.
    let bytes = input.text.len() + input.note.as_deref().map_or(0, str::len);
    if bytes > MAX_REPLY {
        return Err(not_submitted(format!(
            "reply_too_long: this reply is {bytes} bytes; a reply from Home is at most {MAX_REPLY} bytes in UTF-8, \
             where a Chinese character is 3. Nothing was sent, and your reply is kept."
        )));
    }
    let input = reply_target(ws, &project, input).await?;
    refuse_images(ws, &input).await?;
    refuse_files(ws, &input).await?;
    if let Some(version) = input.version {
        ensure!(input.ask_version.is_none() && input.workspace_id.is_none(), "A reply answers a card or an ask, not both");
        ensure!(input.intent == ReplyIntent::Answer && input.note.is_none(), "A note goes to an ask, not a card");
        return card_reply(ws, project, input, version).await;
    }
    ensure!(input.title.is_none(), "A title goes with the version of the card it was shown in");
    if let Some(version) = input.ask_version {
        return ask_reply(ws, project, input, version).await;
    }
    ensure!(input.workspace_id.is_none(), "A Workspace goes with the version of the ask it was shown in");
    ensure!(input.form.is_none(), "A form's answers go with the version of the ask it was shown in");
    ensure!(input.intent == ReplyIntent::Answer && input.note.is_none(), "A note goes with the version of the ask it was shown in");
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
        "sectionId":section.as_ref().map(|row| row.identity),"workspaceId":workspace,"home":snapshot(&name, section.as_ref(), None, None, extra_text(None, &input.text), None)});
    let detail = ws.send_view(&input.agent_id).await?;
    let (agent, client) = (input.agent_id.clone(), input.client_message_id.clone());
    let previous = ws.stored(move |store| store.receipt(&agent, &client)).await?;
    // A retry keeps its first input and files, whatever Turn is running now.
    let (message, files) = match previous {
        Some(previous) if previous.input.text == text && previous.input.images == input.images && previous.files == input.files =>
            (previous.input, previous.files),
        Some(_) => bail!("This clientMessageId was already used for another message"),
        None => {
            adopt_images(ws, &project, &input).await?;
            adopt_files(ws, &project, &input).await?;
            (MessageInput {
                client_message_id: input.client_message_id.clone(),
                text,
                text_blocks: None,
                images: input.images.clone(),
                expected_turn_id: follow_up_turn(&detail),
                question: None,
                clarification: None,
            }, input.files.clone())
        }
    };
    ws.send_message_from(&input.agent_id, message, Vec::new(), files, Some(origin)).await
}

/// A reply meant for a released executor (from a Home that showed it as the
/// section's owner, or its card's responsible Agent, before its release)
/// goes to whoever answers for the section now. For a report or status card
/// of a task that is its responsible Agent (YN-86 S2a, cards.rs), else its
/// owner; for an ask its owner, the one Agent that resolves it. That owner
/// is the dispatcher once the executor's archive handed the section over
/// (T-36). With nobody else it is refused, and nothing is sent.
async fn reply_target(ws: &Arc<Workspace>, project: &str, mut input: ReplyInput) -> Result<ReplyInput> {
    let (agent, key, project) = (input.agent_id.clone(), input.key.clone(), project.to_owned());
    let to_ask = input.ask_version.is_some();
    let owner = ws.stored(move |store| {
        let db = store.db.read()?;
        if crate::executor_release::release_of(&db, &agent)?.is_none() {
            return Ok(None);
        }
        let row = match &key {
            Some(key) => sections::find(&db, &project, key, None)?.filter(|row| row.live),
            None => None,
        };
        let responsible = match row.as_ref().filter(|row| row.kind != "ask" && !to_ask) {
            Some(row) => match cards::Cards::new(&db).binding(row)? {
                Some(task) => cards::responsible(&db, &task)?.map(|who| who.agent),
                None => None,
            },
            None => None,
        };
        let others = |who: &String| *who != agent;
        Ok(Some(responsible.filter(others).or(row.map(|row| row.owner_id).filter(others))))
    }).await?;
    match owner {
        None => Ok(input),
        Some(Some(owner)) => {
            input.agent_id = owner;
            Ok(input)
        }
        Some(None) => Err(not_submitted(
            "executor_archived: the executor this reply is for was released, and no other Agent owns this section. \
             Nothing was sent, and your reply is kept."
                .into(),
        )),
    }
}

/// Refused before anything was recorded: the client keeps its reply, and
/// sending it again is a new message.
fn not_submitted(message: String) -> anyhow::Error {
    anyhow::Error::new(crate::collaboration_credentials::MessageNotSubmitted(anyhow::anyhow!(message)))
}

/// A reply's images (YN-134) once `reply_target` has chosen its recipient:
/// only to an Agent that takes images. Beside a form's answers too
/// (YN-213): Home's form goes as one message with the user's note and what
/// it attached, though a conversation's form goes without them
/// (workspace.rs). Refused, nothing is sent and the client keeps the reply.
async fn refuse_images(ws: &Arc<Workspace>, input: &ReplyInput) -> Result<()> {
    if input.images.is_empty() {
        return Ok(());
    }
    let to = input.agent_id.clone();
    let agent = ws.stored(move |store| store.agent(&to)).await?;
    if !crate::input_images::takes_images(&agent.harness) {
        return Err(not_submitted(format!(
            "images_unsupported: {} can't receive images; Codex, Claude and OpenCode Agents can. Nothing was sent, and your reply is kept.",
            agent.name
        )));
    }
    Ok(())
}

/// Copies a new reply's images from the Project's images written on Home to
/// its recipient's own (input_images::adopt), before the message is sent.
/// A retry already sent is not copied again. Refused, nothing is sent and
/// the client keeps the reply.
async fn adopt_images(ws: &Arc<Workspace>, project: &str, input: &ReplyInput) -> Result<()> {
    if input.images.is_empty() {
        return Ok(());
    }
    let (root, project, agent, images) = (ws.data_dir.clone(), project.to_owned(), input.agent_id.clone(), input.images.clone());
    tokio::task::spawn_blocking(move || crate::input_images::adopt(&root, &project, &agent, &images))
        .await?
        .map_err(|error| not_submitted(format!("home_images: {error}. Nothing was sent, and your reply is kept.")))
}

/// Refuses a reply with files when its recipient takes none (YN-145): nothing
/// was sent, and the reply is kept. A form's answers take them too (YN-213).
async fn refuse_files(ws: &Arc<Workspace>, input: &ReplyInput) -> Result<()> {
    if input.files.is_empty() {
        return Ok(());
    }
    let agent = input.agent_id.clone();
    let found = ws.stored(move |store| store.agent(&agent)).await?;
    if !crate::input_files::takes_files(&found.harness) {
        return Err(not_submitted(format!(
            "files_unsupported: {} can't receive files; Codex, Claude and OpenCode Agents can. Nothing was sent, and your reply is kept.",
            found.name
        )));
    }
    Ok(())
}

/// Copies a new reply's files from the Project's files written on Home to its
/// recipient's own (input_files::adopt), before the message is sent.
async fn adopt_files(ws: &Arc<Workspace>, project: &str, input: &ReplyInput) -> Result<()> {
    if input.files.is_empty() {
        return Ok(());
    }
    // A remote Agent's files are copied to its own folder here and carried to
    // its machine at the send (F4). Only Codex and Claude can be on one: an
    // OpenCode or dsh reply is refused before copying anything.
    let agent = input.agent_id.clone();
    let found = ws.stored(move |store| store.agent(&agent)).await?;
    if found.remote.is_some() && !matches!(found.harness.as_str(), "codex" | "claude") {
        return Err(not_submitted(format!(
            "files_unsupported: {} is on another machine, where only Codex and Claude Agents can receive files. Nothing was sent, and your reply is kept.",
            found.name
        )));
    }
    let (root, project, agent, files) = (ws.data_dir.clone(), project.to_owned(), input.agent_id.clone(), input.files.clone());
    tokio::task::spawn_blocking(move || crate::input_files::adopt(&root, &project, &agent, &files))
        .await?
        .map_err(|error| not_submitted(format!("home_files: {error}. Nothing was sent, and your reply is kept.")))
}

/// What a reply to an ask says, whatever the ask is now: the option chosen
/// and the user's words, and a form's answers when it sent them, as a digest
/// its receipt keeps (T-9), then its images (YN-134), then its files
/// (YN-145). One without a form, images or files digests as it always has,
/// so an earlier receipt still matches.
pub(super) fn reply_digest(choice: Option<&str>, text: &str, form: Option<&FormReply>, images: &[String],
    files: &[crate::input_files::FileRef]) -> String {
    said_digest(choice, text, form, images, files, None, ReplyIntent::Answer)
}

/// `reply_digest` of a whole reply to an ask: with a form's note and a
/// note's intent (YN-213) when it has them. A note and an answer of the same
/// words digest apart, and one without either digests as it always has.
pub(super) fn input_digest(input: &ReplyInput) -> String {
    said_digest(input.choice.as_deref(), &input.text, input.form.as_ref(), &input.images, &input.files,
        input.note.as_deref(), input.intent)
}

#[allow(clippy::too_many_arguments)]
fn said_digest(choice: Option<&str>, text: &str, form: Option<&FormReply>, images: &[String],
    files: &[crate::input_files::FileRef], note: Option<&str>, intent: ReplyIntent) -> String {
    use sha2::{Digest, Sha256};
    let mut said = match form {
        Some(form) => json!([choice, text, {"formId":form.form_id,"answers":form.answers}]),
        None => json!([choice, text]),
    };
    if !images.is_empty() {
        if let Value::Array(said) = &mut said {
            said.push(json!({"images": images}));
        }
    }
    if !files.is_empty() {
        if let Value::Array(said) = &mut said {
            said.push(json!({"files": files}));
        }
    }
    if let (Some(note), Value::Array(said)) = (note, &mut said) {
        said.push(json!({"note": note}));
    }
    if let (ReplyIntent::Note, Value::Array(said)) = (intent, &mut said) {
        said.push(json!({"intent": "note"}));
    }
    format!("{:x}", Sha256::digest(said.to_string().as_bytes()))
}

/// A reply to an ask (T-9): bound to exactly the version the user saw, in
/// the Workspace whose Home showed it. A version Home no longer has, a
/// resolved or removed ask, or another Workspace sends nothing and says so;
/// the client keeps the reply. A retry of a message already sent under this
/// client id returns its receipt even if the ask changed since. A sent reply
/// marks only that version replied, and only while it is still the live
/// ask: never a newer one its owner asked under the same key. A sent note
/// (YN-213) marks nothing: it is kept apart, with the version it was
/// written on (ask_notes), and the ask stays as it was.
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
    ensure!(input.note.is_none() || input.form.is_some(),
        "A note beside the answers goes with a form's answers; with a choice or alone, the reply's text is your words");
    let noting = input.intent == ReplyIntent::Note;
    ensure!(!noting || (input.choice.is_none() && input.form.is_none()), "A note answers nothing: it goes without a choice or a form's answers");
    // The user's words beside a form's answers, when there are any.
    let note = input.note.as_deref().map(str::trim).filter(|note| !note.is_empty());
    let digest = input_digest(&input);
    // The ask as it is now, if it is still the version the user saw.
    let shown = current.as_ref().filter(|row| row.live && row.unresolved_ask() && row.version == version).cloned();
    let chosen = match (&input.choice, &shown) {
        (Some(id), Some(row)) => Some(choice(row, id).context("choice_not_found: the ask offers no such option")?),
        _ => None,
    };
    let (agent, client) = (input.agent_id.clone(), input.client_message_id.clone());
    let previous = ws.stored(move |store| store.receipt(&agent, &client)).await?;
    // A proposal's "new" (YN-237 ④) opens its request once the reply has reached the lead, once however often it is
    // sent: a reply refused or failed opens nothing, and the user may answer again. Whether it can be opened is checked
    // before a reply is first sent: refused (the Project archived, no front desk), the reply sends nothing and is kept,
    // so it never tells the lead of a request Core could not open. "merge" and "later" open nothing: they reach the
    // lead as any reply does. The proposal answered is the version Home has now or, sent again, the one its receipt
    // keeps (`proposal_sent`): what the user chose opens whatever the ask became since.
    let proposal = match (&shown, &previous) {
        (Some(row), _) => proposal_of(row),
        (None, Some(sent)) => sent.origin.as_ref().and_then(|origin| proposal_sent(origin, &key, version)),
        _ => None,
    }
    .filter(|_| !noting);
    let opens = proposal.as_ref().filter(|_| input.choice.as_deref() == Some("new"));
    // Whether this send made the message (YN-223), rather than finding it sent before: a retry's mark is placed by
    // its receipt among the user's other replies, while one made just now is the newest (sections::newest).
    let (receipt, fresh) = if let Some(previous) = previous {
        // The same reply to the same version, sent before: its receipt.
        let same = previous.origin.as_ref().is_some_and(|sent| {
            sent["kind"] == "home" && sent["projectId"] == project && sent["key"] == key
                && sent["version"] == version && sent["reply"] == digest
        });
        ensure!(same, "This clientMessageId was already used for another message");
        // The first send's files: a retry carries them again.
        (ws.send_message_from(&input.agent_id, previous.input, Vec::new(), previous.files, None).await?, false)
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
        if noting {
            ensure!(!input.text.trim().is_empty() || !input.images.is_empty() || !input.files.is_empty(), "Write a note or attach something");
        } else {
            ensure!(!input.text.trim().is_empty() || chosen.is_some(), "Write a reply or choose an option");
        }
        if let Some(proposal) = opens {
            crate::project_requests::may_open(ws, &project, proposal).await?;
        }
        let form = input.form.as_ref().map(|form| form_answers(row, form, &input.text)).transpose()?;
        // The user's own words as the reply showed them: beside a form's
        // answers, its note.
        let words = if form.is_some() { note } else { extra_text(chosen.as_ref(), &input.text) };
        let mut origin = json!({"kind":"home","projectId":project,"key":key,"version":version,"sectionId":row.identity,"workspaceId":workspace,"reply":digest,
            "home":snapshot(&name, Some(row), None, chosen.as_ref(), words, form)});
        // A note says so beside its snapshot, which stays the shape Core writes (input_origin).
        if noting {
            origin["intent"] = json!("note");
        }
        // A proposal's "new" (YN-237 ④) keeps what it opens with its receipt: sent again, it opens that.
        if let Some(proposal) = opens {
            origin["proposal"] = json!({"request": proposal.under, "title": proposal.title, "text": proposal.text});
        }
        let detail = ws.send_view(&input.agent_id).await?;
        adopt_images(ws, &project, &input).await?;
        adopt_files(ws, &project, &input).await?;
        let message = MessageInput {
            client_message_id: input.client_message_id.clone(),
            text: if noting {
                compose_note(&workspace, &name, &project, row, &input.text)
            } else {
                let answer = compose_answer(&workspace, &name, &project, row, chosen.as_ref(), &input.text, note);
                match &proposal {
                    Some(proposal) => format!("{answer}{}", proposal_said(proposal, chosen.as_ref())),
                    None => answer,
                }
            },
            text_blocks: None,
            images: input.images.clone(),
            expected_turn_id: follow_up_turn(&detail),
            question: None,
            clarification: None,
        };
        (ws.send_message_from(&input.agent_id, message, Vec::new(), input.files.clone(), Some(origin)).await?, true)
    };
    // A note is kept with the version it was written on, while that is
    // still the live ask: once, however often it is sent again.
    if noting {
        if let Some(row) = shown.as_ref().filter(|_| delivered(&receipt)) {
            let (store, project_id, key, identity) = (ws.store.clone(), project.clone(), key.clone(), row.identity);
            let (agent, client, text, images, files) =
                (input.agent_id.clone(), input.client_message_id.clone(), input.text.clone(), input.images.clone(), input.files.clone());
            let kept = crate::db::blocking(move || super::ask_notes::record(&store, &super::ask_notes::Note {
                agent: &agent, client_message_id: &client, project: &project_id, key: &key, identity, version,
                text: &text, images: &images, files: &files,
            })).await?;
            if kept {
                announce(ws, Some(&project));
            }
        }
        return Ok(receipt);
    }
    // The reply delivered, the request its proposal's "new" opens is kept before the ask is marked replied. Not kept
    // (the Project archived meanwhile, storage refusing the write), the ask stays as it was and the reply errors, not
    // `not_submitted` since it was sent: Home keeps it to send again under its client ID (T-9), which opens it then,
    // once. The lead's reply says it is open only once the ask shows its number (`show_opened`).
    let opened = match opens.filter(|_| delivered(&receipt)) {
        Some(proposal) => Some(crate::project_requests::keep_proposal(ws, &project, proposal).await.map_err(not_opened)?),
        None => None,
    };
    // Marked on that version only, if it is still the live ask now.
    if shown.is_some() && delivered(&receipt) {
        let reply = match (&chosen, extra_text(chosen.as_ref(), &input.text)) {
            (Some((_, label)), None) => label.clone(),
            (Some((_, label)), Some(text)) => format!("{label}: {text}"),
            (None, text) => text.unwrap_or_default().to_owned(),
        };
        // A form's answers, then the user's note beside them (YN-213).
        let reply = match note {
            Some(note) if input.form.is_some() => format!("{reply}\n\n{note}"),
            _ => reply,
        };
        let reply: String = reply.chars().take(2000).collect();
        // The form's answers by option id, kept only as form_answers took them
        // for the version shown (a retry sent the same answers).
        let form = match (&shown, &input.form) {
            (Some(row), Some(form)) if form_answers(row, form, &input.text).is_ok() => Some(json!({"formId": form.form_id, "answers": form.answers})),
            _ => None,
        };
        // The reply as the user gave it to that version (YN-223): the same
        // snapshot its receipt keeps, read from the same version of the ask,
        // so Home's answered ask shows the question, options and answer the
        // user saw, whatever its owner edits after.
        let kept = shown.as_ref().map(|row| {
            let answers = input.form.as_ref().and_then(|form| form_answers(row, form, &input.text).ok());
            let words = if input.form.is_some() { note } else { extra_text(chosen.as_ref(), &input.text) };
            snapshot(&name, Some(row), None, chosen.as_ref(), words, answers)
        });
        let (store, key, id, images, files) = (ws.store.clone(), key.clone(), project.clone(), input.images.clone(), input.files.clone());
        let (agent, client) = (input.agent_id.clone(), input.client_message_id.clone());
        let marked = move || sections::mark_replied_form(&store, &id, &key, version, &reply, sections::Marked {
            form: form.as_ref(), images: &images, files: &files, snapshot: kept.as_ref(),
            sent: Some(sections::Sent { agent: &agent, client: &client, fresh }),
        });
        if crate::db::blocking(marked).await? {
            announce(ws, Some(&project));
        }
    }
    // The request the proposal opened goes to its front desk: not sent now, it stays kept, not confirmed delivered,
    // with Send again on Home.
    if let Some(opened) = opened {
        let n = opened.n();
        if let Err(error) = crate::project_requests::send_proposal(ws, &project, opened).await {
            eprintln!("Home kept R-{n} of Project {project}, opened from a proposal, without sending it: {error:#}");
        }
    }
    Ok(receipt)
}

/// Why the request a proposal's "new" asks for is not open although the reply reached its lead (YN-237 ④): by the
/// refusal's code, else the error. Never `not_submitted`: the reply was sent, so Home keeps it to send again.
fn not_opened(error: anyhow::Error) -> anyhow::Error {
    let text = error.to_string();
    let why = match text.split_once(':') {
        Some((code, _)) if !code.is_empty() && code.chars().all(|c| c.is_ascii_lowercase() || c == '_') => code.to_owned(),
        _ => format!("{error:#}"),
    };
    anyhow::anyhow!(
        "proposal_not_opened: your reply reached its lead, but Core could not open the new request yet ({why}). Send the reply again \
         to open it; it opens once."
    )
}

/// The proposal an ask is (YN-237 ④), as the version shown has it: the request it was made under, the Ask's identity,
/// version and key, and the new request's title and words. None for any other ask.
fn proposal_of(row: &sections::Row) -> Option<crate::project_requests::Proposal> {
    let proposal = &row.data["ask"]["proposal"];
    Some(crate::project_requests::Proposal {
        under: proposal["request"].as_i64()?,
        identity: row.identity,
        version: row.version,
        key: row.key.clone(),
        title: proposal["title"].as_str()?.to_owned(),
        text: proposal["text"].as_str()?.to_owned(),
    })
}

/// The proposal a reply sent before chose "new" on (YN-237 ④), as its receipt keeps it (`ask_reply`): the request it
/// was made under and what the new request says, of the Ask by its identity and the version answered. None for any
/// other reply, and for one sent before Core kept it.
fn proposal_sent(origin: &Value, key: &str, version: i64) -> Option<crate::project_requests::Proposal> {
    let proposal = &origin["proposal"];
    Some(crate::project_requests::Proposal {
        under: proposal["request"].as_i64()?,
        identity: origin["sectionId"].as_i64()?,
        version,
        key: key.to_owned(),
        title: proposal["title"].as_str()?.to_owned(),
        text: proposal["text"].as_str()?.to_owned(),
    })
}

/// What a reply to a proposal (YN-237 ④) tells its lead, after the user's answer: what Core does of it, by the option
/// chosen. Core opens a request only on "new", once the reply has reached the lead (`ask_reply`), so its number is
/// not known yet and the reply never says it is open; the other answers leave it to the lead.
fn proposal_said(proposal: &crate::project_requests::Proposal, chosen: Option<&(String, String)>) -> String {
    let under = proposal.under;
    match chosen.map(|(id, _)| id.as_str()) {
        Some("new") => format!(
            "\n\nThis answers your proposal of a new request: the user chose to open it. Core opens it once this reply has reached \
             you, as the Project's next request linked to R-{under} both ways, and sends it to the front desk as the user's own request. \
             It is open once this ask shows its number as `ask.proposal.opened` (brief_get); until then it is not, and Home asks the \
             user to send the reply again. Resolve this ask only then; the new work is that request's."),
        Some("merge") => format!(
            "\n\nThis answers your proposal of a new request: the user chose to fold it into R-{under}; Core opened nothing. Do it within R-{under}."),
        Some("later") => "\n\nThis answers your proposal of a new request: the user chose to note it for later; Core opened nothing. Keep it \
             noted, and resolve this ask once you have.".to_owned(),
        _ => "\n\nThis answers your proposal of a new request in words only, choosing none of its options; Core opened nothing.".to_owned(),
    }
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
    // A card of a task tells its responsible Agent so (YN-86 S2a).
    let bound = match &shown {
        Some(row) => {
            let (row, to) = (row.clone(), input.agent_id.clone());
            ws.stored(move |store| {
                let db = store.db.read()?;
                let Some(task) = cards::Cards::new(&db).binding(&row)? else { return Ok(None) };
                let answers = cards::responsible(&db, &task)?.is_some_and(|who| who.agent == to);
                Ok(answers.then(|| crate::collaboration_store::task_shown(&db, &task)))
            }).await?
        }
        None => None,
    };
    let text = compose_bound_card(&workspace, &name, &project, &key, version, &title, bound.as_deref(), &input.text);
    let detail = ws.send_view(&input.agent_id).await?;
    let (agent, client) = (input.agent_id.clone(), input.client_message_id.clone());
    if let Some(previous) = ws.stored(move |store| store.receipt(&agent, &client)).await? {
        let head = card_head(&workspace, &name, &project, &key, version, &title);
        ensure!(same_card_reply(&previous.input.text, &head, &input.text) && previous.input.images == input.images
            && previous.files == input.files, "This clientMessageId was already used for another message");
        return ws.send_message_from(&input.agent_id, previous.input, Vec::new(), previous.files, None).await;
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
    let origin = json!({"kind":"home","projectId":project,"key":key,"version":version,"sectionId":row.identity,"workspaceId":workspace,
        "home":snapshot(&name, Some(&row), Some(&title), None, extra_text(None, &input.text), None)});
    adopt_images(ws, &project, &input).await?;
    adopt_files(ws, &project, &input).await?;
    let message = MessageInput {
        client_message_id: input.client_message_id,
        text,
        text_blocks: None,
        images: input.images,
        expected_turn_id: follow_up_turn(&detail),
        question: None,
        clarification: None,
    };
    ws.send_message_from(&input.agent_id, message, Vec::new(), input.files, Some(origin)).await
}
