//! The turn-end Brief check (Home V1, T-85). It held Turns of a Project's
//! content editors to end with one `brief_update` Core accepted (a valid
//! "no change" included). Since T-154 no Agent must
//! (`project_brief::agent_must_update_brief`): editors update the Brief when
//! something changed, so the check below finds no Agent to remind and Turns
//! end as they are. Outcomes recorded for earlier Turns stay readable.
//!
//! When an Agent must update, this module only records whether it did,
//! from Core's own receipts (`project_brief`), and starts at most one bounded
//! remedy. It never writes Brief content and never judges what a Turn said.
//!
//! - Codex: a Turn that ended `completed` without a receipt gets ONE reminder
//!   Turn through the mailbox's idle Start path (collaboration_runtime), with
//!   its own budget. A failed or interrupted Turn, and a reminder Turn itself,
//!   never gets one.
//! - Claude: the bridge's Stop hook continues the same Turn once and reports
//!   what happened; Core keeps that outcome, and falls back to its receipts
//!   when the bridge said nothing (it exited, or was never asked).
//!
//! Turn ends are read from the journal: every completion Core records (live,
//! recovered after a reconnect, Codex or Claude) is one `turn/completed` row,
//! exactly once per Turn; a replay is journaled as `turn/reconfirmed`. The
//! collaboration loop reads them after a cursor, off the record locks and the
//! writer, and the outcomes and reminder rows below make a replay harmless.
use crate::{store::Store, workspace::Workspace};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::sync::{Arc, RwLock};

/// The clientMessageId prefix of a reminder Turn's input.
pub(crate) const REMINDER_CLIENT_PREFIX: &str = "brief-reminder-";
/// What annotates a reminder Turn and its input for clients.
pub(crate) const REMINDER_SOURCE: &str = "brief-reminder";
const CURSOR_KEY: &str = "briefTurnsSeq";
/// Turn ends read per pass.
const BATCH: i64 = 32;

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    // One row per missed Turn, whatever was decided for it, so a replayed
    // completion never reminds twice:
    // - mode `turn`: a Codex reminder Turn (state sending, delivered,
    //   uncertain or error);
    // - mode `none`: no reminder was started (busy, budget, not connected).
    // Claude needs none: its Stop hook continues the same Turn.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS project_brief_reminders(
            agent_id TEXT NOT NULL, missed_turn_id TEXT NOT NULL, mode TEXT NOT NULL,
            client_message_id TEXT, reminder_turn_id TEXT, state TEXT NOT NULL,
            detail TEXT, at TEXT NOT NULL, PRIMARY KEY(agent_id, missed_turn_id));
        CREATE INDEX IF NOT EXISTS project_brief_reminders_client ON project_brief_reminders(agent_id, client_message_id);
        CREATE INDEX IF NOT EXISTS project_brief_reminders_turn ON project_brief_reminders(agent_id, reminder_turn_id);",
    )?;
    // Turns that ended before this Core checked any are not checked.
    db.execute(
        "INSERT OR IGNORE INTO workspace_meta(key,value) SELECT ?1, CAST(COALESCE(MAX(seq),0) AS TEXT) FROM journal",
        [CURSOR_KEY],
    )?;
    Ok(())
}

/// What this module needs of `project_brief`. Tests put a fake in its place.
pub(crate) trait Seam: Send + Sync {
    fn hard_rules(&self) -> String;
    fn requires(&self, store: &Store, agent: &str) -> Result<Option<String>>;
    fn receipt(&self, store: &Store, agent: &str, turn: &str) -> Result<Option<String>>;
    fn record(&self, store: &Store, agent: &str, turn: &str, project: &str, outcome: &str) -> Result<bool>;
    fn outcome(&self, store: &Store, agent: &str, turn: &str) -> Result<Option<(String, u32)>>;
}

struct ProjectBrief;

impl Seam for ProjectBrief {
    fn hard_rules(&self) -> String {
        crate::project_brief::hard_rules().to_owned()
    }
    fn requires(&self, store: &Store, agent: &str) -> Result<Option<String>> {
        crate::project_brief::agent_must_update_brief(store, agent)
    }
    fn receipt(&self, store: &Store, agent: &str, turn: &str) -> Result<Option<String>> {
        crate::project_brief::turn_receipt(store, agent, turn)
    }
    fn record(&self, store: &Store, agent: &str, turn: &str, project: &str, outcome: &str) -> Result<bool> {
        crate::project_brief::record_turn_outcome(store, agent, turn, project, outcome)
    }
    fn outcome(&self, store: &Store, agent: &str, turn: &str) -> Result<Option<(String, u32)>> {
        crate::project_brief::turn_outcome(store, agent, turn)
    }
}

/// The Workspace's part: the journal position checked so far (also the lock
/// that keeps passes one at a time) and the seam.
pub(crate) struct State {
    cursor: tokio::sync::Mutex<Option<i64>>,
    seam: RwLock<Arc<dyn Seam>>,
}

impl Default for State {
    fn default() -> Self {
        Self { cursor: Default::default(), seam: RwLock::new(Arc::new(ProjectBrief)) }
    }
}

impl State {
    fn seam(&self) -> Arc<dyn Seam> {
        self.seam.read().unwrap().clone()
    }

    #[cfg(test)]
    pub(crate) fn set_seam(&self, seam: Arc<dyn Seam>) {
        *self.seam.write().unwrap() = seam;
    }
}

/// One `turn/completed` journal row.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct TurnEnd {
    pub seq: i64,
    pub agent: String,
    pub turn: String,
    pub status: String,
}

/// Turn ends journaled after `after` (at most BATCH rows), how far the read
/// reached and whether there may be more: the last row's position when the
/// batch is full, else the journal's end when the read began (every row up to
/// it was committed by then).
fn turn_ends(db: &Connection, after: i64) -> Result<(Vec<TurnEnd>, i64, bool)> {
    let end: i64 = db.query_row("SELECT COALESCE(MAX(seq),0) FROM journal", [], |r| r.get(0))?;
    let mut query = db.prepare(
        "SELECT seq,agent_id,json_extract(data,'$.turn.id'),COALESCE(json_extract(data,'$.turn.status'),'')
         FROM journal WHERE seq>?1 AND seq<=?2 AND kind='turn/completed' ORDER BY seq LIMIT ?3",
    )?;
    let rows = query
        .query_map(params![after, end, BATCH], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let full = rows.len() as i64 >= BATCH;
    let reached = match rows.last() {
        Some(row) if full => row.0,
        _ => end,
    };
    let ends = rows
        .into_iter()
        .filter_map(|(seq, agent, turn, status)| Some(TurnEnd { seq, agent, turn: turn?, status }))
        .collect();
    Ok((ends, reached.max(after), full))
}

fn saved_cursor(db: &Connection) -> Result<i64> {
    let value: Option<String> = db
        .query_row("SELECT value FROM workspace_meta WHERE key=?1", [CURSOR_KEY], |r| r.get(0))
        .optional()?;
    Ok(value.and_then(|v| v.parse().ok()).unwrap_or(0))
}

fn save_cursor(db: &Connection, seq: i64) -> Result<()> {
    db.execute(
        "INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![CURSOR_KEY, seq.to_string()],
    )?;
    Ok(())
}

/// The mode of the row kept for a missed Turn (see `migrate`), if any.
fn reminder_mode(db: &Connection, agent: &str, missed: &str) -> Result<Option<String>> {
    Ok(db
        .query_row(
            "SELECT mode FROM project_brief_reminders WHERE agent_id=?1 AND missed_turn_id=?2",
            params![agent, missed],
            |r| r.get(0),
        )
        .optional()?)
}

/// The missed Turn whose reminder `turn` is, if it is a Codex reminder Turn:
/// known by the Turn ID its start returned, else (a start whose answer was
/// lost) by its input's clientMessageId, which is then remembered.
fn reminded_turn(store: &Store, agent: &str, turn: &str) -> Result<Option<String>> {
    let (known, unbound) = {
        let db = store.db.read()?;
        let known: Option<String> = db
            .query_row(
                "SELECT missed_turn_id FROM project_brief_reminders WHERE agent_id=?1 AND mode='turn' AND reminder_turn_id=?2",
                params![agent, turn],
                |r| r.get(0),
            )
            .optional()?;
        let unbound: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM project_brief_reminders WHERE agent_id=?1 AND mode='turn' AND reminder_turn_id IS NULL AND state IN ('sending','uncertain'))",
            [agent],
            |r| r.get(0),
        )?;
        (known, unbound)
    };
    if known.is_some() || !unbound {
        return Ok(known);
    }
    // That Turn's user messages, without payloads (T-140).
    let found = store.turn(agent, turn)?;
    let clients: Vec<String> = found
        .as_ref()
        .and_then(|t| t["items"].as_array())
        .into_iter()
        .flatten()
        .filter(|item| item["type"] == "userMessage")
        .filter_map(|item| item["clientId"].as_str())
        .filter(|id| id.starts_with(REMINDER_CLIENT_PREFIX))
        .map(str::to_owned)
        .collect();
    if clients.is_empty() {
        return Ok(None);
    }
    let db = store.db.write()?;
    let missed: Option<String> = db
        .query_row(
            "SELECT missed_turn_id FROM project_brief_reminders WHERE agent_id=?1 AND mode='turn' AND reminder_turn_id IS NULL
               AND client_message_id IN (SELECT value FROM json_each(?2))",
            params![agent, json!(clients).to_string()],
            |r| r.get(0),
        )
        .optional()?;
    if let Some(missed) = &missed {
        db.execute(
            "UPDATE project_brief_reminders SET reminder_turn_id=?3 WHERE agent_id=?1 AND missed_turn_id=?2",
            params![agent, missed, turn],
        )?;
    }
    Ok(missed)
}

/// What a Turn end needs after the store work.
#[derive(Debug, PartialEq)]
pub(crate) enum Decision {
    Done,
    /// A Codex Turn ended `completed` with no receipt and nothing recorded
    /// for it yet: try its one reminder.
    Remind { project: String },
}

/// The decision table, all of it store work (a blocking job). Outcomes are
/// final once recorded, except `reminded`: the one remedy's result replaces
/// it (`project_brief::record_turn_outcome`).
pub(crate) fn decide(seam: &dyn Seam, store: &Store, end: &TurnEnd) -> Result<Decision> {
    let Some(project) = seam.requires(store, &end.agent)? else { return Ok(Decision::Done) };
    let record = |turn: &str, outcome: &str| seam.record(store, &end.agent, turn, &project, outcome);
    let harness = match store.agent(&end.agent) {
        Ok(agent) => agent.harness,
        Err(_) => return Ok(Decision::Done),
    };
    let receipt = seam.receipt(store, &end.agent, &end.turn)?;
    if harness == "codex" {
        if let Some(missed) = reminded_turn(store, &end.agent, &end.turn)? {
            // A reminder Turn is never reminded. Its result is the missed
            // Turn's: remedied by its receipt, else (ended without one,
            // failed or interrupted) the remedy failed.
            if let Some(kind) = &receipt {
                record(&end.turn, kind)?;
            }
            record(&missed, receipt.as_deref().unwrap_or("remindFailed"))?;
            return Ok(Decision::Done);
        }
    }
    if let Some(kind) = receipt {
        record(&end.turn, &kind)?;
        return Ok(Decision::Done);
    }
    if end.status != "completed" {
        record(&end.turn, "skipped")?;
        return Ok(Decision::Done);
    }
    let recorded = seam.outcome(store, &end.agent, &end.turn)?;
    if harness == "claude" {
        // The bridge reports the Turn's outcome before its result; this is
        // the fallback when it did not (it exited, or was not asked). Held
        // once by the Stop hook (`reminded`) and still nothing: it failed.
        match recorded.as_ref().map(|(outcome, _)| outcome.as_str()) {
            None => {
                record(&end.turn, "missing")?;
            }
            Some("reminded") => {
                record(&end.turn, "remindFailed")?;
            }
            Some(_) => {}
        }
        return Ok(Decision::Done);
    }
    if harness != "codex" {
        record(&end.turn, "missing")?;
        return Ok(Decision::Done);
    }
    // A replay: something was decided for this Turn already.
    if recorded.is_some() || reminder_mode(&*store.db.read()?, &end.agent, &end.turn)?.is_some() {
        return Ok(Decision::Done);
    }
    Ok(Decision::Remind { project })
}

/// What the bridge's Stop hook reported (`{type:'brief', turnId, outcome}`).
/// `blocked`: it held this Turn's stop once and the Turn goes on, kept as
/// `reminded` (one reminder, not final). The others are the Turn's own
/// outcome, sent once before its result frame. An update counts only if Core
/// holds its receipt; without one the Turn's end records the fallback.
pub(crate) fn record_bridge_outcome(ws: &Workspace, agent: &str, turn: &str, outcome: &str) -> Result<()> {
    let seam = ws.brief_turns.seam();
    let store = &*ws.store;
    let Some(project) = seam.requires(store, agent)? else { return Ok(()) };
    let record = |outcome: &str| seam.record(store, agent, turn, &project, outcome);
    if !matches!(outcome, "blocked" | "updated" | "noChange" | "missing" | "skipped") {
        return Ok(());
    }
    if let Some(kind) = seam.receipt(store, agent, turn)? {
        // Before an update, the hook may still have held the stop once.
        if outcome != "blocked" {
            record(&kind)?;
        }
        return Ok(());
    }
    let held = || -> Result<bool> {
        Ok(seam.outcome(store, agent, turn)?.is_some_and(|(outcome, _)| outcome == "reminded"))
    };
    match outcome {
        "blocked" => {
            record("reminded")?;
        }
        "missing" if held()? => {
            record("remindFailed")?;
        }
        "missing" | "skipped" => {
            record(outcome)?;
        }
        _ => {}
    }
    Ok(())
}

/// Claude start option `brief`, inside the Yuzuno MCP branch (the bridge
/// refuses `required:true` without it).
pub(crate) async fn claude_start_option(ws: &Workspace, agent: &str) -> Result<Value> {
    let seam = ws.brief_turns.seam();
    let id = agent.to_owned();
    let check = seam.clone();
    let required = ws.stored(move |store| check.requires(store, &id)).await?.is_some();
    Ok(json!({"required":required,"recheck":true,"hardRules":if required { seam.hard_rules() } else { String::new() }}))
}

/// Codex start/resume params with the Brief's hard rules after the configured
/// developer instructions and the result notice, for a Project's Agent. Only
/// where Core composed `developerInstructions` (the Yuzuno MCP is attached and
/// the configured text was read): otherwise sending the field would replace
/// the configured text. The same rules are in the MCP server instructions.
pub(crate) async fn with_hard_rules(ws: &Workspace, agent: &str, mut params: Value) -> Value {
    let Some(instructions) = params["developerInstructions"].as_str().map(str::to_owned) else { return params };
    let seam = ws.brief_turns.seam();
    let (id, check) = (agent.to_owned(), seam.clone());
    match ws.stored(move |store| check.requires(store, &id)).await {
        Ok(Some(_)) => {
            params["developerInstructions"] = format!("{}\n\n{}", instructions.trim_end(), seam.hard_rules()).into();
        }
        Ok(None) => {}
        Err(error) => eprintln!("Brief rules not added for Agent {agent}: {error:#}"),
    }
    params
}

/// The reminder's input: names the missed Turn and the three tools. Nothing
/// from the conversation is quoted.
pub(crate) fn reminder_text(missed_turn: &str) -> String {
    format!(
        "[Yuzuno Brief reminder — automatic, from Yuzuno Core]\nYour previous turn ({missed_turn}) ended without an accepted Project Brief update. Call the yuzuno tool brief_get, then brief_update with the version it returned: your changes, or noChange:true when the Brief needs none. If a call is rejected, fix the listed problems (brief_guide explains each part) and submit again. This is the only reminder for that turn; do not redo other work."
    )
}

/// Whether to keep going after a Turn end.
#[derive(Debug, PartialEq)]
enum Flow {
    Next,
    /// Core is draining for an update: check this Turn end again later.
    Wait,
}

impl Workspace {
    /// Checks the Turn ends journaled since the last pass. Called by the
    /// collaboration loop before mail, so a reminder for the Turn that just
    /// ended goes before the next mailbox wake-up.
    pub(crate) async fn check_brief_turns(self: &Arc<Self>) -> Result<()> {
        let mut cursor = self.brief_turns.cursor.lock().await;
        let mut after = match *cursor {
            Some(after) => after,
            None => self.stored(|store| saved_cursor(&*store.db.read()?)).await?,
        };
        loop {
            let (ends, reached, full) = self.stored(move |store| turn_ends(&*store.db.read()?, after)).await?;
            let checked = !ends.is_empty();
            let mut next = reached;
            for end in ends {
                match self.check_turn_end(&end).await {
                    Ok(Flow::Next) => {}
                    Ok(Flow::Wait) => {
                        next = end.seq - 1;
                        break;
                    }
                    // Not retried: a reminder must never repeat on an error.
                    Err(error) => eprintln!("Brief check of Agent {} turn {}: {error:#}", end.agent, end.turn),
                }
            }
            let waited = next < reached;
            if checked && next > after {
                // Saved only when a Turn end was checked: a restart reads the
                // rows after it again, which costs a range scan only.
                self.stored(move |store| save_cursor(&*store.db.write()?, next)).await?;
            }
            after = next.max(after);
            *cursor = Some(after);
            if waited || !full {
                return Ok(());
            }
        }
    }

    async fn check_turn_end(self: &Arc<Self>, end: &TurnEnd) -> Result<Flow> {
        let seam = self.brief_turns.seam();
        let (check, owned) = (seam.clone(), end.clone());
        match self.stored(move |store| decide(&*check, store, &owned)).await? {
            Decision::Done => Ok(Flow::Next),
            Decision::Remind { project } => self.remind(seam, end, &project).await,
        }
    }

    /// The one reminder Turn for a missed Codex Turn, through the mailbox's
    /// idle Start path with its own budget. Whatever is decided is kept
    /// (`project_brief_reminders`) before anything is sent.
    async fn remind(self: &Arc<Self>, seam: Arc<dyn Seam>, end: &TurnEnd, project: &str) -> Result<Flow> {
        let Ok(_permit) = self.admission.enter_work() else { return Ok(Flow::Wait) };
        let not_started = |reason: &'static str| {
            let (agent, missed, project, check) = (end.agent.clone(), end.turn.clone(), project.to_owned(), seam.clone());
            self.stored(move |store| {
                if check.requires(store, &agent)?.as_deref() != Some(project.as_str()) { return Ok(()); }
                store.db.write()?.execute(
                    "INSERT OR IGNORE INTO project_brief_reminders(agent_id,missed_turn_id,mode,state,detail,at) VALUES(?1,?2,'none','notStarted',?3,?4)",
                    params![agent, missed, reason, crate::model::now()],
                )?;
                check.record(store, &agent, &missed, &project, "missing")?;
                Ok(())
            })
        };
        let gate = self.gate(&end.agent).await;
        // A lifecycle operation holding the gate this long means the Agent is
        // not idle for a reminder.
        let Ok(_held) = tokio::time::timeout(std::time::Duration::from_secs(10), gate.lock()).await else {
            not_started("busy").await?;
            return Ok(Flow::Next);
        };
        // The policy may have changed while this reminder waited for the
        // lifecycle gate. Ask-only members incur no reminder or missing row.
        let (check, agent, member_of) = (seam.clone(), end.agent.clone(), project.to_owned());
        if !self.stored(move |store| Ok(check.requires(store, &agent)?.as_deref() == Some(member_of.as_str()))).await? {
            return Ok(Flow::Next);
        }
        if !self.brief_reminder_ready(&end.agent).await? {
            not_started("busy").await?;
            return Ok(Flow::Next);
        }
        let agent = end.agent.clone();
        let ws = self.clone();
        if !crate::db::blocking(move || ws.reserve_brief_reminder(&agent)).await? {
            not_started("budget").await?;
            return Ok(Flow::Next);
        }
        let client = format!("{REMINDER_CLIENT_PREFIX}{}", uuid::Uuid::new_v4());
        let (agent, missed, member_of, client_id, check) =
            (end.agent.clone(), end.turn.clone(), project.to_owned(), client.clone(), seam.clone());
        let reserved = self.stored(move |store| {
            if check.requires(store, &agent)?.as_deref() != Some(member_of.as_str()) { return Ok(false); }
            let inserted = store.db.write()?.execute(
                "INSERT OR IGNORE INTO project_brief_reminders(agent_id,missed_turn_id,mode,client_message_id,state,at) VALUES(?1,?2,'turn',?3,'sending',?4)",
                params![agent, missed, client_id, crate::model::now()],
            )?;
            if inserted == 0 {
                return Ok(false);
            }
            // Before the start, so a restart never starts a second one.
            if !check.record(store, &agent, &missed, &member_of, "reminded")? {
                store.db.write()?.execute(
                    "UPDATE project_brief_reminders SET mode='none',state='notStarted',detail='outcome already final' WHERE agent_id=?1 AND missed_turn_id=?2",
                    params![agent, missed],
                )?;
                return Ok(false);
            }
            Ok(true)
        }).await?;
        if !reserved {
            return Ok(Flow::Next);
        }
        // Re-read immediately before dispatch, not just when the completed
        // turn was first examined or when its session started.
        let (check, agent, missed, member_of) = (seam.clone(), end.agent.clone(), end.turn.clone(), project.to_owned());
        let required = self.stored(move |store| {
            if check.requires(store, &agent)?.as_deref() == Some(member_of.as_str()) { return Ok(true); }
            store.db.write()?.execute(
                "UPDATE project_brief_reminders SET mode='none',state='notStarted',detail='content permission changed' WHERE agent_id=?1 AND missed_turn_id=?2",
                params![agent, missed],
            )?;
            check.record(store, &agent, &missed, &member_of, "skipped")?;
            Ok(false)
        }).await?;
        if !required { return Ok(Flow::Next); }
        let result = self.send_locked(&end.agent, reminder_text(&end.turn), Some(&client)).await;
        let (state, turn, error) = match &result {
            Ok(value) => ("delivered", value["turnId"].as_str().map(str::to_owned), None),
            Err(error) if error.downcast_ref::<crate::rpc::OutcomeUnknown>().is_some() => ("uncertain", None, Some(error.to_string())),
            Err(error) => ("error", None, Some(error.to_string())),
        };
        let (agent, missed, project) = (end.agent.clone(), end.turn.clone(), project.to_owned());
        self.stored(move |store| {
            store.db.write()?.execute(
                "UPDATE project_brief_reminders SET state=?3,reminder_turn_id=COALESCE(?4,reminder_turn_id),detail=?5 WHERE agent_id=?1 AND missed_turn_id=?2",
                params![agent, missed, state, turn, error],
            )?;
            // Refused, so no reminder Turn will report: the remedy failed.
            if state == "error" {
                seam.record(store, &agent, &missed, &project, "remindFailed")?;
            }
            Ok(())
        }).await?;
        Ok(Flow::Next)
    }
}

/// Marks a Codex reminder Turn and its input `_yuzunoSource:"brief-reminder"`
/// (the conversation shows a Yuzuno reminder card), from this module's rows
/// only, never from the text. Part of `mailbox_notice::annotate_turns`.
pub(crate) fn annotate(db: &Connection, agent: &str, conversation: &mut [Value]) -> Result<()> {
    let mut clients = Vec::new();
    let mut turns = Vec::new();
    for turn in conversation.iter() {
        if let Some(id) = turn["id"].as_str() {
            turns.push(id.to_owned());
        }
        for item in turn["items"].as_array().into_iter().flatten() {
            if item["type"] == "userMessage" {
                if let Some(id) = item["clientId"].as_str().filter(|id| id.starts_with(REMINDER_CLIENT_PREFIX)) {
                    clients.push(id.to_owned());
                }
            }
        }
    }
    if turns.is_empty() && clients.is_empty() {
        return Ok(());
    }
    let any: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM project_brief_reminders WHERE agent_id=?1 AND mode='turn')",
        [agent],
        |r| r.get(0),
    )?;
    if !any {
        return Ok(());
    }
    let mut query = db.prepare(
        "SELECT client_message_id,reminder_turn_id FROM project_brief_reminders
           WHERE agent_id=?1 AND mode='turn' AND client_message_id IN (SELECT value FROM json_each(?2))
         UNION SELECT client_message_id,reminder_turn_id FROM project_brief_reminders
           WHERE agent_id=?1 AND mode='turn' AND reminder_turn_id IN (SELECT value FROM json_each(?3))",
    )?;
    let rows = query
        .query_map(params![agent, json!(clients).to_string(), json!(turns).to_string()], |r| {
            Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    for (client, reminder_turn) in rows {
        for turn in conversation.iter_mut() {
            let by_turn = reminder_turn.is_some() && turn["id"].as_str() == reminder_turn.as_deref();
            let mut first_user = true;
            let mut marked = false;
            for item in turn["items"].as_array_mut().into_iter().flatten() {
                if item["type"] != "userMessage" {
                    continue;
                }
                let by_client = client.is_some() && item["clientId"].as_str() == client.as_deref();
                if by_client || (by_turn && first_user && item["clientId"].as_str().is_none_or(|id| id.starts_with(REMINDER_CLIENT_PREFIX))) {
                    item["_yuzunoSource"] = REMINDER_SOURCE.into();
                    marked = true;
                }
                first_user = false;
            }
            if by_turn || marked {
                turn["_yuzunoSource"] = REMINDER_SOURCE.into();
            }
        }
    }
    Ok(())
}

#[cfg(all(test, unix))]
pub(crate) mod tests {
    use super::*;
    use crate::model::AgentDetail;
    use std::{collections::HashMap, os::unix::fs::PermissionsExt, sync::Mutex};

    /// `project_brief` as these tests need it: `reminded` is the only outcome
    /// a later one replaces, and each `reminded` counts one reminder.
    #[derive(Default)]
    pub(crate) struct Fake {
        pub projects: Mutex<HashMap<String, String>>,
        pub receipts: Mutex<HashMap<(String, String), String>>,
        pub outcomes: Mutex<HashMap<(String, String), (String, u32)>>,
    }

    impl Fake {
        pub(crate) fn member(agent: &str) -> Arc<Self> {
            let fake = Self::default();
            fake.projects.lock().unwrap().insert(agent.into(), "p1".into());
            Arc::new(fake)
        }
        pub(crate) fn receipt(&self, agent: &str, turn: &str, kind: &str) {
            self.receipts.lock().unwrap().insert((agent.into(), turn.into()), kind.into());
        }
        pub(crate) fn recorded(&self, agent: &str, turn: &str) -> Option<(String, u32)> {
            self.outcomes.lock().unwrap().get(&(agent.to_owned(), turn.to_owned())).cloned()
        }
    }

    impl Seam for Fake {
        fn hard_rules(&self) -> String {
            "BRIEF HARD RULES: call brief_update every turn.".into()
        }
        fn requires(&self, _: &Store, agent: &str) -> Result<Option<String>> {
            Ok(self.projects.lock().unwrap().get(agent).cloned())
        }
        fn receipt(&self, _: &Store, agent: &str, turn: &str) -> Result<Option<String>> {
            Ok(self.receipts.lock().unwrap().get(&(agent.to_owned(), turn.to_owned())).cloned())
        }
        fn record(&self, _: &Store, agent: &str, turn: &str, _: &str, outcome: &str) -> Result<bool> {
            let mut outcomes = self.outcomes.lock().unwrap();
            let key = (agent.to_owned(), turn.to_owned());
            let reminders = outcomes.get(&key).map_or(0, |o| o.1) + u32::from(outcome == "reminded");
            if outcomes.get(&key).is_some_and(|(o, _)| o != "reminded") {
                return Ok(false);
            }
            outcomes.insert(key, (outcome.into(), reminders));
            Ok(true)
        }
        fn outcome(&self, _: &Store, agent: &str, turn: &str) -> Result<Option<(String, u32)>> {
            Ok(self.recorded(agent, turn))
        }
    }

    const NATIVE: &str = r#"#!/usr/bin/python3
import json,sys,pathlib
root=pathlib.Path(__file__).parent
class _TurnsList:
    """thread/turns/list answered as this fake's thread/read (T-140)."""
    def __init__(self, raw): self.raw, self.ids, self.buf = raw, set(), ''
    def write(self, text):
        self.buf += text
        while '\n' in self.buf:
            line, self.buf = self.buf.split('\n', 1)
            try:
                v = json.loads(line)
                if isinstance(v, dict) and v.get('id') in self.ids and 'result' in v:
                    self.ids.discard(v['id'])
                    turns = ((v['result'] or {}).get('thread') or {}).get('turns') or []
                    v['result'] = {'data': list(reversed(turns)), 'nextCursor': None}
                    line = json.dumps(v)
            except ValueError: pass
            self.raw.write(line + '\n')
        return len(text)
    def flush(self): self.raw.flush()
sys.stdout = _TurnsList(sys.stdout)
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 m=r['method']; p=r.get('params',{})
 if m=='thread/turns/list': sys.stdout.ids.add(r['id']); m='thread/read'
 result={}
 if m in ['thread/start','thread/resume']:
  with (root/'attach.jsonl').open('a') as f:f.write(json.dumps({'method':m,'params':p})+'\n')
 if m in ['thread/start','thread/resume','thread/read']:
  result={'thread':{'id':'native-thread','status':{'type':'idle'},'turns':[]}}
 if m=='config/read':
  result={'config':{'developer_instructions':'Configured by the user.'}}
 if m=='turn/start':
  starts=root/'starts.jsonl'
  n=len(starts.read_text().splitlines()) if starts.exists() else 0
  with starts.open('a') as f:f.write(json.dumps(p)+'\n')
  result={'turn':{'id':'reminder-%d'%(n+1),'status':'inProgress','items':[]}}
 print(json.dumps({'id':r['id'],'result':result}),flush=True)
"#;

    async fn fixture(harness: &str, thread: Option<&str>, fake: Arc<Fake>) -> (tempfile::TempDir, Arc<Workspace>) {
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("native.py");
        std::fs::write(&script, NATIVE).unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), script.to_string_lossy().into()).unwrap();
        ws.collaboration_url.set("http://127.0.0.1:4999".into()).unwrap();
        ws.brief_turns.set_seam(fake);
        let detail: AgentDetail = serde_json::from_value(json!({"agent":{
            "id":"a","name":"A","cwd":"/tmp","model":"","color":"sage","threadId":thread,"harness":harness,
            "status":"offline","createdAt":"","updatedAt":"","unreadCount":0,"pendingCount":0,
            "lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
        ws.store.insert(&detail).unwrap();
        if harness == "codex" {
            ws.reconnect("a").await.unwrap();
        }
        (dir, ws)
    }

    fn end(ws: &Workspace, turn: &str, status: &str) {
        let event = json!({"turn":{"id":turn,"status":status,"items":[]}});
        ws.store.update("a", "turn/completed", &event, |d| d.apply("turn/completed", &event)).unwrap();
    }

    fn starts(dir: &tempfile::TempDir) -> Vec<Value> {
        std::fs::read_to_string(dir.path().join("starts.jsonl"))
            .map(|text| text.lines().map(|l| serde_json::from_str(l).unwrap()).collect())
            .unwrap_or_default()
    }

    fn outcome(fake: &Fake, turn: &str) -> Option<(String, u32)> {
        fake.recorded("a", turn)
    }

    fn set(outcome: &str, reminders: u32) -> Option<(String, u32)> {
        Some((outcome.into(), reminders))
    }

    #[tokio::test]
    async fn codex_reminder_rechecks_permission_after_the_turn_end_decision() {
        let fake = Fake::member("a");
        let (dir, ws) = fixture("codex", None, fake.clone()).await;
        end(&ws, "revoked", "completed");
        let ended = TurnEnd { seq: 0, agent: "a".into(), turn: "revoked".into(), status: "completed".into() };
        assert_eq!(decide(&*fake, &ws.store, &ended).unwrap(), Decision::Remind { project: "p1".into() });
        fake.projects.lock().unwrap().remove("a");
        ws.remind(fake.clone(), &ended, "p1").await.unwrap();
        assert!(starts(&dir).is_empty(), "revoked permission must not launch a reminder turn");
        assert_eq!(outcome(&fake, "revoked"), None);
        record_bridge_outcome(&ws, "a", "revoked-claude", "missing").unwrap();
        assert_eq!(outcome(&fake, "revoked-claude"), None);
        ws.close_agent("a").await.unwrap();
    }

    #[tokio::test]
    async fn codex_reminder_rechecks_permission_after_waiting_for_the_lifecycle_gate() {
        let fake = Fake::member("a");
        let (dir, ws) = fixture("codex", None, fake.clone()).await;
        end(&ws, "gate-revoked", "completed");
        let ended = TurnEnd { seq: 0, agent: "a".into(), turn: "gate-revoked".into(), status: "completed".into() };
        assert_eq!(decide(&*fake, &ws.store, &ended).unwrap(), Decision::Remind { project: "p1".into() });
        let gate = ws.gate("a").await;
        let held = gate.lock().await;
        let pending = ws.remind(fake.clone(), &ended, "p1");
        tokio::pin!(pending);
        tokio::select! {
            biased;
            result = &mut pending => panic!("reminder must wait for the held gate: {result:?}"),
            _ = tokio::task::yield_now() => {}
        }
        fake.projects.lock().unwrap().remove("a");
        drop(held);
        assert_eq!(pending.await.unwrap(), Flow::Next);
        assert!(starts(&dir).is_empty());
        assert_eq!(outcome(&fake, "gate-revoked"), None);
        assert_eq!(reminder_mode(&ws.store.db.read().unwrap(), "a", "gate-revoked").unwrap(), None);
        ws.close_agent("a").await.unwrap();
    }

    #[tokio::test]
    async fn codex_decision_table_reminds_once_and_never_for_reminders_failures_or_replays() {
        let fake = Fake::member("a");
        let (dir, ws) = fixture("codex", None, fake.clone()).await;
        // A receipt: recorded, nothing started.
        end(&ws, "t-receipt", "completed");
        fake.receipt("a", "t-receipt", "noChange");
        // Failed and interrupted Turns never get a reminder.
        end(&ws, "t-failed", "failed");
        end(&ws, "t-interrupted", "interrupted");
        ws.check_brief_turns().await.unwrap();
        assert_eq!(outcome(&fake, "t-receipt"), set("noChange", 0));
        assert_eq!(outcome(&fake, "t-failed"), set("skipped", 0));
        assert_eq!(outcome(&fake, "t-interrupted"), set("skipped", 0));
        assert!(starts(&dir).is_empty());

        // Completed without a receipt: one reminder Turn naming the tools and the Turn.
        end(&ws, "t-missed", "completed");
        ws.check_brief_turns().await.unwrap();
        assert_eq!(outcome(&fake, "t-missed"), set("reminded", 1));
        let sent = starts(&dir);
        assert_eq!(sent.len(), 1);
        let client = sent[0]["clientUserMessageId"].as_str().unwrap();
        assert!(client.starts_with(REMINDER_CLIENT_PREFIX), "{client}");
        let text = sent[0]["input"][0]["text"].as_str().unwrap();
        for name in ["brief_get", "brief_update", "brief_guide", "t-missed"] {
            assert!(text.contains(name), "{text}");
        }
        // The conversation shows it as a Yuzuno reminder.
        let detail = ws.store.detail("a").unwrap();
        let reminder = detail.turns.iter().find(|t| t["id"] == "reminder-1").unwrap();
        assert_eq!(reminder["_yuzunoSource"], REMINDER_SOURCE);
        assert!(detail.turns.iter().find(|t| t["id"] == "t-missed").unwrap().get("_yuzunoSource").is_none());

        // The reminder Turn ends without a receipt: the remedy failed, kept
        // on the missed Turn, and no new reminder.
        end(&ws, "reminder-1", "completed");
        ws.check_brief_turns().await.unwrap();
        assert_eq!(outcome(&fake, "t-missed"), set("remindFailed", 1));
        assert_eq!(outcome(&fake, "reminder-1"), None);
        assert_eq!(starts(&dir).len(), 1);

        // A restart replays from the saved position, and a reconnect may
        // report the same completion again: no second reminder.
        *ws.brief_turns.cursor.lock().await = Some(0);
        ws.store.record_recovered_completion("a", &json!({"id":"t-missed","status":"completed","items":[]})).unwrap();
        ws.check_brief_turns().await.unwrap();
        assert_eq!(starts(&dir).len(), 1);
        assert_eq!(outcome(&fake, "t-missed"), set("remindFailed", 1));
        assert_eq!(outcome(&fake, "reminder-1"), None);
        let saved = saved_cursor(&*ws.store.db.read().unwrap()).unwrap();
        assert!(saved > 0);

        // Within the minute after a reminder the budget is spent: missing only.
        end(&ws, "t-budget", "completed");
        ws.check_brief_turns().await.unwrap();
        assert_eq!(outcome(&fake, "t-budget"), set("missing", 0));
        assert_eq!(starts(&dir).len(), 1);
        // Not a member of any live Project: nothing is recorded.
        fake.projects.lock().unwrap().clear();
        end(&ws, "t-outside", "completed");
        ws.check_brief_turns().await.unwrap();
        assert_eq!(outcome(&fake, "t-outside"), None);
        ws.close_agent("a").await.unwrap();
    }

    #[tokio::test]
    async fn codex_reminder_with_a_receipt_counts_and_a_busy_agent_keeps_its_budget() {
        let fake = Fake::member("a");
        let (dir, ws) = fixture("codex", None, fake.clone()).await;
        // Pending requests make the Agent busy: missing, no reminder, no budget spent.
        end(&ws, "t-busy", "completed");
        ws.store.update("a", "test/pending", &json!({}), |d| d.pending.push(crate::model::PendingRequest {
            id: "p".into(), agent_id: "a".into(), method: "item/tool/requestUserInput".into(),
            params: json!({"turnId":"t-busy","isBlocking":true}), created_at: crate::model::now(), stale: false,
        })).unwrap();
        ws.check_brief_turns().await.unwrap();
        assert_eq!(outcome(&fake, "t-busy"), set("missing", 0));
        assert!(starts(&dir).is_empty());
        ws.store.update("a", "test/answered", &json!({}), |d| { d.pending.clear(); d.agent.status = "idle".into(); }).unwrap();
        end(&ws, "t-next", "completed");
        ws.check_brief_turns().await.unwrap();
        assert_eq!(outcome(&fake, "t-next"), set("reminded", 1));
        assert_eq!(starts(&dir).len(), 1);
        // The reminder Turn updates the Brief: the missed Turn is remedied.
        fake.receipt("a", "reminder-1", "updated");
        end(&ws, "reminder-1", "completed");
        ws.check_brief_turns().await.unwrap();
        assert_eq!(outcome(&fake, "reminder-1"), set("updated", 0));
        assert_eq!(outcome(&fake, "t-next"), set("updated", 1));
        assert_eq!(starts(&dir).len(), 1);
        ws.close_agent("a").await.unwrap();
    }

    /// T-154, with the real policy: a content editor's Turn that ends without
    /// a Brief update is neither held, reminded nor marked, on either harness.
    #[tokio::test]
    async fn no_agent_must_update_the_brief_and_a_turn_without_one_ends_as_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let ws = Workspace::new(dir.path().join("data"), "/tmp".into(), "unused-harness".into()).unwrap();
        let project = ws.store.create_project("Code", Default::default()).unwrap().id;
        for (id, harness) in [("a", "codex"), ("b", "claude")] {
            let detail: AgentDetail = serde_json::from_value(json!({"agent":{"id":id,"name":id,"cwd":"/tmp","model":"",
                "color":"sage","harness":harness,"status":"idle","createdAt":"","updatedAt":"","unreadCount":0,
                "pendingCount":0,"lastSeq":0,"reviewedSeq":0},"turns":[],"pending":[],"artifacts":[]})).unwrap();
            ws.store.insert(&detail).unwrap();
            ws.store.set_agent_project(id, Some(&project)).unwrap();
            // A content editor of a live Project, as the user's default makes it.
            assert_eq!(crate::project_brief::agent_edits_brief(&ws.store, id).unwrap(), Some(project.clone()));
            let seam = ws.brief_turns.seam();
            assert_eq!(seam.requires(&ws.store, id).unwrap(), None);
            let end = TurnEnd { seq: 1, agent: id.into(), turn: "quiet".into(), status: "completed".into() };
            assert_eq!(decide(&*seam, &ws.store, &end).unwrap(), Decision::Done);
            assert_eq!(seam.outcome(&ws.store, id, "quiet").unwrap(), None, "nothing is marked missing");
            assert_eq!(claude_start_option(&ws, id).await.unwrap(), json!({"required":false,"recheck":true,"hardRules":""}));
            // The rules stay in the MCP server instructions; the session text
            // no longer carries a second copy.
            let params = json!({"developerInstructions":"Configured by the user.\n\nNotice."});
            assert_eq!(with_hard_rules(&ws, id, params.clone()).await, params);
        }
        let reminders: i64 = ws.store.db.read().unwrap()
            .query_row("SELECT COUNT(*) FROM project_brief_reminders", [], |r| r.get(0)).unwrap();
        assert_eq!(reminders, 0);
    }

    #[tokio::test]
    async fn developer_instructions_carry_the_hard_rules_on_start_and_resume() {
        for thread in [None, Some("native-thread")] {
            let fake = Fake::member("a");
            let (dir, ws) = fixture("codex", thread, fake).await;
            let attach: Value = serde_json::from_str(std::fs::read_to_string(dir.path().join("attach.jsonl")).unwrap().lines().next().unwrap()).unwrap();
            assert_eq!(attach["method"], if thread.is_some() { "thread/resume" } else { "thread/start" });
            let text = attach["params"]["developerInstructions"].as_str().unwrap();
            // Configured text first, then the result notice, then the rules.
            let configured = text.find("Configured by the user.").unwrap();
            let notice = text.find(crate::results::capability_notice()).unwrap();
            let rules = text.find("BRIEF HARD RULES").unwrap();
            assert!(configured < notice && notice < rules, "{text}");
            ws.close_agent("a").await.unwrap();
        }
        // Not a Project's Agent: the notice alone, still on resume.
        let (dir, ws) = fixture("codex", Some("native-thread"), Arc::new(Fake::default())).await;
        let attach: Value = serde_json::from_str(std::fs::read_to_string(dir.path().join("attach.jsonl")).unwrap().lines().next().unwrap()).unwrap();
        let text = attach["params"]["developerInstructions"].as_str().unwrap();
        assert!(text.contains(crate::results::capability_notice()) && !text.contains("BRIEF HARD RULES"), "{text}");
        ws.close_agent("a").await.unwrap();
    }

    #[tokio::test]
    async fn claude_keeps_the_bridge_outcome_and_falls_back_to_receipts() {
        let fake = Fake::member("a");
        let (_dir, ws) = fixture("claude", None, fake.clone()).await;
        let bridge = |turn: &str, outcome: &str| record_bridge_outcome(&ws, "a", turn, outcome).unwrap();
        // Held once (not final), then still nothing: the remedy failed.
        bridge("c-held", "blocked");
        assert_eq!(outcome(&fake, "c-held"), set("reminded", 1));
        bridge("c-held", "missing");
        end(&ws, "c-held", "completed");
        // Held once, then updated within the same Turn.
        bridge("c-fixed", "blocked");
        fake.receipt("a", "c-fixed", "updated");
        bridge("c-fixed", "updated");
        end(&ws, "c-fixed", "completed");
        // The bridge's word without Core's receipt is not an update.
        bridge("c-claimed", "updated");
        end(&ws, "c-claimed", "completed");
        // Local commands and interrupted Turns.
        bridge("c-local", "skipped");
        end(&ws, "c-local", "completed");
        // The bridge exited: no outcome from it, with or without a hold.
        end(&ws, "c-silent", "completed");
        bridge("c-exited", "blocked");
        end(&ws, "c-exited", "completed");
        bridge("c-stopped", "blocked");
        end(&ws, "c-stopped", "interrupted");
        // The hook may hold once more after an update: the update stands.
        fake.receipt("a", "c-early", "noChange");
        bridge("c-early", "blocked");
        bridge("c-early", "noChange");
        end(&ws, "c-early", "completed");
        ws.check_brief_turns().await.unwrap();
        assert_eq!(outcome(&fake, "c-held"), set("remindFailed", 1));
        assert_eq!(outcome(&fake, "c-fixed"), set("updated", 1));
        assert_eq!(outcome(&fake, "c-claimed"), set("missing", 0));
        assert_eq!(outcome(&fake, "c-local"), set("skipped", 0));
        assert_eq!(outcome(&fake, "c-silent"), set("missing", 0));
        assert_eq!(outcome(&fake, "c-exited"), set("remindFailed", 1));
        assert_eq!(outcome(&fake, "c-stopped"), set("skipped", 1));
        assert_eq!(outcome(&fake, "c-early"), set("noChange", 0));
        // Start option: inside the MCP branch, with the rules only when required.
        assert_eq!(claude_start_option(&ws, "a").await.unwrap(), json!({"required":true,"recheck":true,"hardRules":"BRIEF HARD RULES: call brief_update every turn."}));
        fake.projects.lock().unwrap().clear();
        assert_eq!(claude_start_option(&ws, "a").await.unwrap(), json!({"required":false,"recheck":true,"hardRules":""}));
    }

    #[test]
    fn turn_ends_read_completions_only_and_report_how_far_they_reached() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("w.sqlite")).unwrap();
        let db = store.db.write().unwrap();
        let start = saved_cursor(&db).unwrap();
        for (kind, data) in [
            ("turn/started", json!({"turn":{"id":"x"}})),
            ("turn/completed", json!({"turn":{"id":"x","status":"completed"}})),
            ("turn/reconfirmed", json!({"turn":{"id":"x","status":"completed"}})),
            ("turn/completed", json!({"turn":{"status":"completed"}})),
            ("turn/completed", json!({"turn":{"id":"y","status":"interrupted"},"recovered":true})),
            ("item/completed", json!({})),
        ] {
            db.execute("INSERT INTO journal(agent_id,kind,data,at) VALUES('a',?1,?2,'now')", params![kind, data.to_string()]).unwrap();
        }
        let (ends, reached, full) = turn_ends(&db, start).unwrap();
        assert_eq!(ends.iter().map(|e| (e.turn.as_str(), e.status.as_str())).collect::<Vec<_>>(), vec![("x", "completed"), ("y", "interrupted")]);
        assert_eq!((reached, full), (start + 6, false));
        assert_eq!(turn_ends(&db, reached).unwrap(), (vec![], reached, false));
    }
}
