//! Opt-in automatic continue after a Claude usage limit resets (T-94).
//!
//! Claude Code's own `autoContinueAtUsageLimit` does nothing for Yuzuno:
//! CLI 2.1.280 arms it only when `launchOptions.isInteractive()`, and an SDK
//! session (stream-json over pipes) is never interactive. So Core does it,
//! from Claude's own signals only:
//! - a Claude turn failed while the latest `rate_limit_event`, reported during
//!   that same turn, said `rejected` with a `resetsAt` and no overage in use.
//!   Any other failure (network, API, authentication) is not a usage limit;
//! - the setting is on: off by default for the workspace, and each Agent can
//!   turn it on or off for itself.
//!
//! Then one resume intent per failed turn is kept (`claude_quota_resumes`),
//! naming the Agent, its session, the failed turn and Claude's reset. A little
//! after the reset (Agents waiting for the same reset of one account are
//! staggered) Core sends one fixed continuation message through the ordinary
//! message path. Its client message id comes from the intent, so a restart or a
//! second timer never sends it twice. No earlier prompt or tool is sent again,
//! and approvals stay as they are. Just before sending it checks again, and
//! cancels instead, when:
//! - the setting is off;
//! - the Agent is closed or gone, or its session changed;
//! - anything newer than the failed turn exists, i.e. the user sent something.
//!
//! A continuation stopped by the limit again arms once more for Claude's next
//! reset, up to MAX_ATTEMPTS. A "Continue now" the limit stopped was the
//! user's own try: the automatic continue waits again, for the reset Claude
//! reported. Without a reset time nothing is armed, and no time is guessed.
use crate::{
    model::{AgentDetail, MessageInput},
    server::ApiError,
    store::Store,
    workspace::Workspace,
};
use anyhow::{Context, Result};
use axum::{
    extract::{Path, State as ApiState},
    routing::{get, post},
    Json, Router,
};
use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{sync::Arc, time::Duration};

/// After Claude's reset, so the first request is not refused at the boundary.
pub const GRACE_SECS: i64 = 60;
/// Between Agents of one account waiting for the same reset.
pub const STAGGER_SECS: i64 = 30;
/// Farther than this Claude Code itself does not wait either.
pub const MAX_WAIT_SECS: i64 = 24 * 60 * 60;
/// Continuations of one stop, the first included.
pub const MAX_ATTEMPTS: i64 = 3;

pub const CONTINUE_TEXT: &str = "[Yuzuno · automatic continue] Claude's usage limit has reset. Automatic continue is on for this agent, so Yuzuno sent this one message. Continue the task you were working on when the limit stopped you. First check what already finished; don't repeat completed steps or tool calls that already ran.";

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS claude_auto_continue(scope TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS claude_quota_resumes(
            id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, turn_id TEXT NOT NULL, session_id TEXT NOT NULL,
            resets_at INTEGER NOT NULL, limit_type TEXT, account TEXT NOT NULL, attempt INTEGER NOT NULL,
            due_at INTEGER NOT NULL, state TEXT NOT NULL, reason TEXT, sent_turn TEXT,
            by_user INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(agent_id, turn_id));
         CREATE INDEX IF NOT EXISTS claude_quota_resumes_state ON claude_quota_resumes(state, due_at);",
    )?;
    Ok(())
}

/// A Claude turn the usage limit stopped, as Claude reported it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Stop {
    pub turn_id: String,
    pub session_id: String,
    pub resets_at: i64,
    pub limit_type: Option<String>,
    /// Who shares the limit: the account Claude Code reported.
    pub account: String,
}

/// The Agent's latest turn, if the usage limit stopped it: failed, with a
/// `rejected` limit (not on overage) reported during the turn, and a reset
/// still ahead (within the grace) and no farther than Claude Code itself
/// would wait. A stop whose reset has passed is history: turning automatic
/// continue on later must not resume that session by itself.
pub(crate) fn usage_limit_stop(d: &AgentDetail, now: i64) -> Option<Stop> {
    if d.agent.harness != "claude" || d.agent.remote.is_some() || d.agent.closed_at.is_some() {
        return None;
    }
    let turn = d.turns.last()?;
    if turn["status"] != "failed" {
        return None;
    }
    let session_id = d.agent.claude_session_id.clone()?;
    let runtime = d.claude_runtime.as_ref()?;
    let info = runtime.rate_limits.as_ref()?;
    if info["status"] != "rejected" || info["isUsingOverage"] == true || info["overageInUse"] == true {
        return None;
    }
    let resets_at = info["resetsAt"].as_f64().filter(|t| t.is_finite() && *t > 0.0)? as i64;
    let reported = runtime.rate_limits_at.as_deref().and_then(|t| DateTime::parse_from_rfc3339(t).ok())?.timestamp_millis();
    if reported < turn["_yuzunoStartedAt"].as_i64()? || resets_at - now > MAX_WAIT_SECS || resets_at + GRACE_SECS <= now {
        return None;
    }
    let account = runtime.account.as_ref()
        .and_then(|a| a["email"].as_str().or(a["organization"].as_str()).map(str::to_owned))
        .unwrap_or_else(|| "unknown".into());
    Some(Stop {
        turn_id: turn["id"].as_str()?.to_owned(),
        session_id,
        resets_at,
        limit_type: info["rateLimitType"].as_str().map(str::to_owned),
        account,
    })
}

/// When the `rank`-th Agent (from 0) waiting for this reset continues.
pub fn due_at(resets_at: i64, rank: i64) -> i64 {
    resets_at + GRACE_SECS + rank.max(0) * STAGGER_SECS
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub id: String,
    pub agent_id: String,
    pub turn_id: String,
    pub session_id: String,
    pub resets_at: i64,
    pub limit_type: Option<String>,
    pub attempt: i64,
    pub due_at: i64,
    /// waiting, sending, sent, cancelled, failed or uncertain.
    pub state: String,
    pub reason: Option<String>,
    pub sent_turn: Option<String>,
    /// Claimed by the user's "Continue now", not by its timer.
    pub by_user: bool,
}

const COLUMNS: &str = "id,agent_id,turn_id,session_id,resets_at,limit_type,attempt,due_at,state,reason,sent_turn,by_user";

fn intent(r: &rusqlite::Row) -> rusqlite::Result<Intent> {
    Ok(Intent {
        id: r.get(0)?, agent_id: r.get(1)?, turn_id: r.get(2)?, session_id: r.get(3)?, resets_at: r.get(4)?,
        limit_type: r.get(5)?, attempt: r.get(6)?, due_at: r.get(7)?, state: r.get(8)?, reason: r.get(9)?, sent_turn: r.get(10)?,
        by_user: r.get(11)?,
    })
}

/// Why a waiting intent must not send now, if it must not.
pub(crate) fn cancel_reason(d: &AgentDetail, i: &Intent, enabled: bool) -> Option<&'static str> {
    if !enabled {
        return Some("Automatic continue was turned off");
    }
    if d.agent.closed_at.is_some() {
        return Some("The agent was closed");
    }
    if d.agent.disconnected_at.is_some() {
        return Some("You disconnected the agent");
    }
    if d.agent.claude_session_id.as_deref() != Some(i.session_id.as_str()) {
        return Some("The Claude session changed");
    }
    match d.turns.last() {
        Some(t) if t["id"] == i.turn_id.as_str() && t["status"] == "failed" => {}
        Some(t) if t["id"] == i.turn_id.as_str() => return Some("The stopped turn changed"),
        _ => return Some("Something newer was sent to the agent"),
    }
    if d.message_receipts.iter().any(|r| matches!(r.status.as_str(), "sending" | "uncertain")) {
        return Some("An earlier message's delivery is still unconfirmed");
    }
    None
}

fn scope(agent: Option<&str>) -> String {
    agent.map_or_else(|| "workspace".into(), |a| format!("agent:{a}"))
}

impl Store {
    fn auto_continue_setting(db: &Connection, agent: Option<&str>) -> Result<Option<bool>> {
        Ok(db.query_row("SELECT enabled FROM claude_auto_continue WHERE scope=?1", [scope(agent)], |r| r.get::<_, i64>(0))
            .optional()?.map(|v| v != 0))
    }

    /// The workspace default (off unless set), this Agent's own choice, and
    /// what applies.
    pub fn auto_continue(&self, agent: &str) -> Result<(bool, Option<bool>, bool)> {
        let db = self.db.read()?;
        let workspace = Self::auto_continue_setting(&db, None)?.unwrap_or(false);
        let own = Self::auto_continue_setting(&db, Some(agent))?;
        Ok((workspace, own, own.unwrap_or(workspace)))
    }

    /// Sets the workspace default (`agent` None) or an Agent's own choice;
    /// `None` returns the Agent to the default.
    pub fn set_auto_continue(&self, agent: Option<&str>, enabled: Option<bool>) -> Result<()> {
        let db = self.db.write()?;
        match enabled {
            Some(on) => db.execute("INSERT INTO claude_auto_continue(scope,enabled) VALUES(?1,?2)
                ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled", params![scope(agent), on as i64])?,
            None => db.execute("DELETE FROM claude_auto_continue WHERE scope=?1", [scope(agent)])?,
        };
        Ok(())
    }

    /// Records the intent for this stop, once per failed turn. A stop that an
    /// automatic continuation ran into is that intent's next attempt: armed
    /// only for a later reset, and at most MAX_ATTEMPTS times. One that the
    /// user's "Continue now" ran into (Claude refused it before the reset)
    /// waits again as the same attempt.
    pub(crate) fn arm_quota_resume(&self, agent: &str, stop: &Stop, now: i64) -> Result<Option<Intent>> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        if tx.query_row("SELECT 1 FROM claude_quota_resumes WHERE agent_id=?1 AND turn_id=?2", params![agent, stop.turn_id], |_| Ok(()))
            .optional()?.is_some() {
            return Ok(None);
        }
        let workspace = Self::auto_continue_setting(&tx, None)?.unwrap_or(false);
        if !Self::auto_continue_setting(&tx, Some(agent))?.unwrap_or(workspace) {
            return Ok(None);
        }
        // The continue that started this turn: one that names it, or one
        // still sending (the limit can stop its turn before it is named).
        let earlier: Option<(i64, i64, bool)> = tx.query_row(
            "SELECT attempt,resets_at,by_user FROM claude_quota_resumes WHERE agent_id=?1 AND (sent_turn=?2 OR state='sending')
             ORDER BY created_at DESC, rowid DESC LIMIT 1",
            params![agent, stop.turn_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).optional()?;
        let (attempt, state, reason) = match earlier {
            Some((attempt, _, true)) => (attempt, "waiting", None),
            Some((attempt, _, _)) if attempt >= MAX_ATTEMPTS =>
                (attempt + 1, "failed", Some(format!("Still limited after {MAX_ATTEMPTS} automatic continues; continue by hand"))),
            Some((attempt, previous, _)) if stop.resets_at <= previous =>
                (attempt + 1, "failed", Some("Claude reported no later reset; continue by hand".to_owned())),
            Some((attempt, _, _)) => (attempt + 1, "waiting", None),
            None => (1, "waiting", None),
        };
        let rank: i64 = tx.query_row(
            "SELECT COUNT(*) FROM claude_quota_resumes WHERE state='waiting' AND resets_at=?1 AND account=?2",
            params![stop.resets_at, stop.account], |r| r.get(0))?;
        let id = uuid::Uuid::new_v4().to_string();
        let due = due_at(stop.resets_at, rank);
        tx.execute(&format!("INSERT INTO claude_quota_resumes({COLUMNS},account,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,0,?11,?12,?12)"),
            params![id, agent, stop.turn_id, stop.session_id, stop.resets_at, stop.limit_type, attempt, due, state, reason, stop.account, now])?;
        let armed = tx.query_row(&format!("SELECT {COLUMNS} FROM claude_quota_resumes WHERE id=?1"), [&id], intent)?;
        tx.commit()?;
        Ok(Some(armed))
    }

    pub fn quota_resume(&self, id: &str) -> Result<Option<Intent>> {
        let db = self.db.read()?;
        Ok(db.query_row(&format!("SELECT {COLUMNS} FROM claude_quota_resumes WHERE id=?1"), [id], intent).optional()?)
    }

    /// The Agent's newest intent.
    pub fn latest_quota_resume(&self, agent: &str) -> Result<Option<Intent>> {
        let db = self.db.read()?;
        Ok(db.query_row(&format!("SELECT {COLUMNS} FROM claude_quota_resumes WHERE agent_id=?1 ORDER BY created_at DESC, rowid DESC LIMIT 1"),
            [agent], intent).optional()?)
    }

    fn quota_resumes_in(&self, states: &str) -> Result<Vec<Intent>> {
        let db = self.db.read()?;
        let mut query = db.prepare(&format!("SELECT {COLUMNS} FROM claude_quota_resumes WHERE state IN ({states}) ORDER BY due_at"))?;
        let rows = query.query_map([], intent)?.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Moves an intent from one state to another, if it is still in `from`:
    /// true when this call made the change.
    fn move_quota_resume(&self, id: &str, from: &str, to: &str, reason: Option<&str>, sent_turn: Option<&str>, now: i64) -> Result<bool> {
        let db = self.db.write()?;
        Ok(db.execute("UPDATE claude_quota_resumes SET state=?3, reason=COALESCE(?4,reason), sent_turn=COALESCE(?5,sent_turn), updated_at=?6
            WHERE id=?1 AND state=?2",
            params![id, from, to, reason, sent_turn, now])? == 1)
    }

    /// Claims a waiting intent for sending, once: when it is due, or at any
    /// time for the user's "Continue now". True when this call claimed it.
    fn claim_quota_resume(&self, id: &str, by_user: bool, now: i64) -> Result<bool> {
        let db = self.db.write()?;
        Ok(db.execute("UPDATE claude_quota_resumes SET state='sending', by_user=?2, updated_at=?3
            WHERE id=?1 AND state='waiting' AND (?2 OR due_at<=?3)",
            params![id, by_user, now])? == 1)
    }
}

fn now() -> i64 {
    Utc::now().timestamp()
}

/// Whether the usage limit stopped the record's last Turn, now: taken from
/// the committed record when Core records a Claude `result`.
pub(crate) fn result_stop(d: &AgentDetail) -> Option<Stop> {
    usage_limit_stop(d, now())
}

/// Called after Core recorded a Claude `result` with `result_stop` of the
/// committed record: arms an intent when the usage limit stopped this turn
/// and automatic continue is on.
pub(crate) fn observe_result(ws: &Arc<Workspace>, id: &str, stop: Option<Stop>) {
    let Some(stop) = stop else { return };
    let (ws, id) = (ws.clone(), id.to_owned());
    tokio::spawn(async move {
        if let Err(error) = ws.arm_claude_quota_resume(&id, stop).await {
            eprintln!("Claude automatic continue: {error:#}");
        }
    });
}

fn schedule(ws: &Arc<Workspace>, intent: &Intent) {
    let weak = Arc::downgrade(ws);
    let (id, wait) = (intent.id.clone(), (intent.due_at - now()).max(0) as u64);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_secs(wait)).await;
        let Some(ws) = weak.upgrade() else { return };
        if let Err(error) = ws.fire_claude_quota_resume(&id, false).await {
            eprintln!("Claude automatic continue: {error:#}");
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct View {
    /// The workspace default.
    pub workspace: bool,
    /// This Agent's own choice; null follows the workspace default.
    pub agent: Option<bool>,
    pub enabled: bool,
    /// The newest intent, while it concerns the latest turn or still waits.
    pub intent: Option<Intent>,
    /// The latest turn, if the usage limit stopped it.
    pub stopped: Option<StopView>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopView {
    pub turn_id: String,
    pub resets_at: i64,
    pub limit_type: Option<String>,
}

impl Workspace {
    /// Schedules every intent still waiting, and settles one a stop of Core
    /// left sending: its message receipt says whether it went.
    pub fn start_claude_quota_resume(self: &Arc<Self>) {
        let ws = self.clone();
        tokio::spawn(async move {
            let pending = match ws.stored(|store| store.quota_resumes_in("'waiting','sending'")).await {
                Ok(pending) => pending,
                Err(error) => return eprintln!("Claude automatic continue: {error:#}"),
            };
            for i in pending {
                if i.state == "waiting" {
                    schedule(&ws, &i);
                } else if let Err(error) = ws.settle_claude_quota_resume(&i).await {
                    eprintln!("Claude automatic continue: {error:#}");
                }
            }
        });
    }

    async fn settle_claude_quota_resume(self: &Arc<Self>, i: &Intent) -> Result<()> {
        let client = format!("quota-resume-{}", i.id);
        let receipt = self.detail(&i.agent_id).await.ok()
            .and_then(|d| d.message_receipts.into_iter().find(|r| r.input.client_message_id == client));
        let (id, now) = (i.id.clone(), now());
        let _ = match receipt {
            // Never requested: nothing went, so it waits again.
            None => {
                self.stored(move |s| s.move_quota_resume(&id, "sending", "waiting", None, None, now)).await?;
                if let Some(i) = self.stored({ let id = i.id.clone(); move |s| s.quota_resume(&id) }).await? { schedule(self, &i); }
                return Ok(());
            }
            Some(r) => {
                let (to, reason) = receipt_state(&r.status, r.error.as_deref());
                let turn = r.turn_id.clone();
                self.stored(move |s| s.move_quota_resume(&id, "sending", to, reason.as_deref(), turn.as_deref(), now)).await?
            }
        };
        self.changed(&i.agent_id);
        Ok(())
    }

    pub(crate) async fn arm_claude_quota_resume(self: &Arc<Self>, agent: &str, stop: Stop) -> Result<Option<Intent>> {
        let (id, now) = (agent.to_owned(), now());
        let armed = self.stored(move |s| s.arm_quota_resume(&id, &stop, now)).await?;
        if let Some(i) = &armed {
            self.update_record(agent, "claude/autoContinue", json!({"intent":i}), |_| {}).await?;
            if i.state == "waiting" {
                schedule(self, i);
            }
            self.changed(agent);
        }
        Ok(armed)
    }

    /// Sends the continuation when the intent is due (now, if `now_by_user`)
    /// and nothing has made it wrong to send.
    pub async fn fire_claude_quota_resume(self: &Arc<Self>, intent_id: &str, now_by_user: bool) -> Result<Intent> {
        let (id, at) = (intent_id.to_owned(), now());
        let claimed = self.stored(move |s| s.claim_quota_resume(&id, now_by_user, at)).await?;
        let key = intent_id.to_owned();
        let i = self.stored(move |s| s.quota_resume(&key)).await?.context("No such automatic continue")?;
        if !claimed {
            // Not waiting any more, or a timer fired early (the clock moved): wait again.
            if i.state == "waiting" { schedule(self, &i); }
            return Ok(i);
        }
        let agent = i.agent_id.clone();
        let cancel = match self.detail(&agent).await {
            Err(_) => Some("The agent was deleted"),
            Ok(d) => {
                let (_, _, enabled) = self.stored({ let a = agent.clone(); move |s| s.auto_continue(&a) }).await?;
                cancel_reason(&d, &i, enabled || now_by_user)
            }
        };
        let (id, at) = (i.id.clone(), now());
        if let Some(reason) = cancel {
            self.stored(move |s| s.move_quota_resume(&id, "sending", "cancelled", Some(reason), None, at)).await?;
        } else {
            let input = MessageInput { client_message_id: format!("quota-resume-{}", i.id), text: CONTINUE_TEXT.into(), text_blocks: None,
                images: vec![], expected_turn_id: None, question: None, clarification: None };
            let (to, reason, turn) = match self.send_message(&agent, input).await {
                Ok(r) => { let (to, reason) = receipt_state(&r.status, r.error.as_deref()); (to, reason, r.turn_id) }
                Err(error) => ("failed", Some(error.to_string()), None),
            };
            self.stored(move |s| s.move_quota_resume(&id, "sending", to, reason.as_deref(), turn.as_deref(), at)).await?;
        }
        let key = i.id.clone();
        let done = self.stored(move |s| s.quota_resume(&key)).await?.context("No such automatic continue")?;
        if self.detail(&agent).await.is_ok() {
            self.update_record(&agent, "claude/autoContinue", json!({"intent":done}), |_| {}).await?;
        }
        self.changed(&agent);
        Ok(done)
    }

    /// Cancels the Agent's waiting intent, if it still waits.
    pub async fn cancel_claude_quota_resume(self: &Arc<Self>, agent: &str, intent_id: &str, reason: &'static str) -> Result<()> {
        let (id, agent_id, at) = (intent_id.to_owned(), agent.to_owned(), now());
        let moved = self.stored(move |s| {
            let owned = s.quota_resume(&id)?.is_some_and(|i| i.agent_id == agent_id);
            Ok(owned && s.move_quota_resume(&id, "waiting", "cancelled", Some(reason), None, at)?)
        }).await?;
        if moved {
            self.update_record(agent, "claude/autoContinue", json!({"cancelled":intent_id,"reason":reason}), |_| {}).await?;
            self.changed(agent);
        }
        Ok(())
    }

    /// What the UI shows. A waiting intent that may no longer send is
    /// cancelled here, so it is never shown as waiting.
    pub async fn claude_auto_continue(self: &Arc<Self>, agent: &str) -> Result<View> {
        let d = self.detail(agent).await?;
        anyhow::ensure!(d.agent.harness == "claude", "Automatic continue is for Claude agents");
        let a = agent.to_owned();
        let ((workspace, own, enabled), latest) = self.stored(move |s| Ok((s.auto_continue(&a)?, s.latest_quota_resume(&a)?))).await?;
        let mut intent = latest;
        if let Some(i) = intent.as_ref().filter(|i| i.state == "waiting") {
            if let Some(reason) = cancel_reason(&d, i, enabled) {
                self.cancel_claude_quota_resume(agent, &i.id, reason).await?;
                let key = i.id.clone();
                intent = self.stored(move |s| s.quota_resume(&key)).await?;
            }
        }
        let last = d.turns.last().and_then(|t| t["id"].as_str());
        let intent = intent.filter(|i| i.state == "waiting" || Some(i.turn_id.as_str()) == last || i.sent_turn.as_deref() == last);
        let stopped = usage_limit_stop(&d, now()).map(|s| StopView { turn_id: s.turn_id, resets_at: s.resets_at, limit_type: s.limit_type });
        Ok(View { workspace, agent: own, enabled, intent, stopped })
    }

    /// Sets the Agent's own choice (or the workspace default when `agent` is
    /// None). Turning it on arms the latest turn, if the limit stopped it;
    /// turning it off cancels what waits.
    pub async fn set_claude_auto_continue(self: &Arc<Self>, agent: Option<&str>, enabled: Option<bool>) -> Result<()> {
        let (a, now) = (agent.map(str::to_owned), now());
        self.stored(move |s| s.set_auto_continue(a.as_deref(), enabled)).await?;
        let waiting = self.stored(|s| s.quota_resumes_in("'waiting'")).await?;
        let agents: Vec<String> = match agent {
            Some(agent) => vec![agent.to_owned()],
            None => self.stored(|s| s.agents()).await?.into_iter().filter(|a| a.harness == "claude").map(|a| a.id).collect(),
        };
        for id in agents {
            let key = id.clone();
            let (_, _, on) = self.stored(move |s| s.auto_continue(&key)).await?;
            if !on {
                for i in waiting.iter().filter(|i| i.agent_id == id) {
                    self.cancel_claude_quota_resume(&id, &i.id, "Automatic continue was turned off").await?;
                }
            } else if let Some(stop) = self.detail(&id).await.ok().and_then(|d| usage_limit_stop(&d, now)) {
                self.arm_claude_quota_resume(&id, stop).await?;
            }
        }
        Ok(())
    }
}

fn receipt_state(status: &str, error: Option<&str>) -> (&'static str, Option<String>) {
    match status {
        "accepted" | "queued" => ("sent", None),
        "uncertain" | "sending" => ("uncertain", Some(error.unwrap_or("The message's delivery is unconfirmed; reconnect to check").to_owned())),
        _ => ("failed", Some(error.unwrap_or("Claude refused the message").to_owned())),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Setting {
    /// For an Agent, null returns it to the workspace default.
    enabled: Option<bool>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct IntentRef {
    intent_id: String,
}

async fn workspace_setting(ApiState(ws): ApiState<Arc<Workspace>>) -> Result<Json<Value>, ApiError> {
    let enabled = ws.stored(|s| { let db = s.db.read()?; Store::auto_continue_setting(&db, None) }).await?.unwrap_or(false);
    Ok(Json(json!({"enabled":enabled})))
}

async fn set_workspace_setting(ApiState(ws): ApiState<Arc<Workspace>>, Json(input): Json<Setting>) -> Result<Json<Value>, ApiError> {
    let enabled = input.enabled.context("Choose on or off for the workspace default")?;
    let _permit = ws.admission.enter_work()?;
    ws.set_claude_auto_continue(None, Some(enabled)).await?;
    Ok(Json(json!({"enabled":enabled})))
}

async fn agent_view(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>) -> Result<Json<View>, ApiError> {
    Ok(Json(ws.claude_auto_continue(&id).await?))
}

async fn set_agent_setting(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<Setting>) -> Result<Json<View>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    if ws.detail(&id).await?.agent.harness != "claude" {
        return Err(anyhow::anyhow!("Automatic continue is for Claude agents").into());
    }
    ws.set_claude_auto_continue(Some(&id), input.enabled).await?;
    Ok(Json(ws.claude_auto_continue(&id).await?))
}

async fn cancel(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<IntentRef>) -> Result<Json<View>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    ws.cancel_claude_quota_resume(&id, &input.intent_id, "You chose not to continue automatically").await?;
    Ok(Json(ws.claude_auto_continue(&id).await?))
}

async fn continue_now(ApiState(ws): ApiState<Arc<Workspace>>, Path(id): Path<String>, Json(input): Json<IntentRef>) -> Result<Json<View>, ApiError> {
    let _permit = ws.admission.enter_work()?;
    let i = ws.stored({ let key = input.intent_id.clone(); move |s| s.quota_resume(&key) }).await?;
    if !i.is_some_and(|i| i.agent_id == id) {
        return Err(anyhow::anyhow!("No such automatic continue for this agent").into());
    }
    ws.fire_claude_quota_resume(&input.intent_id, true).await?;
    Ok(Json(ws.claude_auto_continue(&id).await?))
}

pub fn router() -> Router<Arc<Workspace>> {
    Router::new()
        .route("/api/claude/auto-continue", get(workspace_setting).post(set_workspace_setting))
        .route("/api/agents/{id}/claude/auto-continue", get(agent_view).post(set_agent_setting))
        .route("/api/agents/{id}/claude/auto-continue/cancel", post(cancel))
        .route("/api/agents/{id}/claude/auto-continue/now", post(continue_now))
}

#[cfg(test)]
mod tests {
    use super::*;

    const RESET: i64 = 1_792_226_400;

    fn detail(turns: Value, limits: Value, reported_ms: i64) -> AgentDetail {
        let reported = DateTime::<Utc>::from_timestamp_millis(reported_ms).unwrap().to_rfc3339();
        serde_json::from_value(json!({"agent": {
            "id":"a","name":"Claude","goal":"","cwd":"/tmp","model":"","color":"sage","harness":"claude","threadId":null,
            "status":"error","createdAt":"now","updatedAt":"now","unreadCount":0,"pendingCount":0,"lastMessage":null,"lastSeq":0,
            "reviewedSeq":0,"error":null,"connectionState":"connected","claudeSessionId":"s1"},
            "turns":turns,"pending":[],"artifacts":[],
            "claudeRuntime":{"account":{"email":"me@example.com"},"rateLimits":limits,"rateLimitsAt":reported}})).unwrap()
    }
    // As CLI 2.1.280 reported the five-hour limit on 2026-10-17 (T-94 evidence).
    fn rejected() -> Value {
        json!({"status":"rejected","resetsAt":RESET,"rateLimitType":"five_hour","isUsingOverage":false,
            "overageStatus":"rejected","overageDisabledReason":"org_level_disabled"})
    }
    fn failed(started_ms: i64) -> Value {
        json!([{"id":"t0","status":"completed","items":[],"_yuzunoStartedAt":1},
            {"id":"t1","status":"failed","items":[],"_yuzunoStartedAt":started_ms,
             "error":{"message":"You've hit your session limit · resets 4:40am (America/New_York)"}}])
    }

    #[test]
    fn only_a_turn_the_reported_limit_stopped_is_a_usage_limit_stop() {
        let now = RESET - 3600;
        let stop = usage_limit_stop(&detail(failed(1_000), rejected(), 2_000), now).unwrap();
        assert_eq!(stop, Stop { turn_id: "t1".into(), session_id: "s1".into(), resets_at: RESET,
            limit_type: Some("five_hour".into()), account: "me@example.com".into() });
        // A limit reported before the turn started is not why it failed.
        assert_eq!(usage_limit_stop(&detail(failed(3_000), rejected(), 2_000), now), None);
        // A failure while Claude said the limit allowed it: not a usage limit.
        let mut allowed = rejected();
        allowed["status"] = "allowed".into();
        assert_eq!(usage_limit_stop(&detail(failed(1_000), allowed, 2_000), now), None);
        // No reset time: nothing to wait for, and none is guessed.
        let mut unknown = rejected();
        unknown.as_object_mut().unwrap().remove("resetsAt");
        assert_eq!(usage_limit_stop(&detail(failed(1_000), unknown, 2_000), now), None);
        // On overage, or a reset farther than Claude Code itself would wait.
        let mut overage = rejected();
        overage["isUsingOverage"] = true.into();
        assert_eq!(usage_limit_stop(&detail(failed(1_000), overage, 2_000), now), None);
        assert_eq!(usage_limit_stop(&detail(failed(1_000), rejected(), 2_000), RESET - MAX_WAIT_SECS - 1), None);
        // A reset already past (beyond the grace) is history: nothing to arm.
        assert!(usage_limit_stop(&detail(failed(1_000), rejected(), 2_000), RESET + GRACE_SECS - 1).is_some());
        assert_eq!(usage_limit_stop(&detail(failed(1_000), rejected(), 2_000), RESET + GRACE_SECS), None);
        // Only the latest turn, and only a failed one.
        let mut done = failed(1_000);
        done[1]["status"] = "completed".into();
        assert_eq!(usage_limit_stop(&detail(done, rejected(), 2_000), now), None);
        let mut later = failed(1_000);
        later.as_array_mut().unwrap().push(json!({"id":"t2","status":"inProgress","items":[],"_yuzunoStartedAt":5_000}));
        assert_eq!(usage_limit_stop(&detail(later, rejected(), 2_000), now), None);
    }

    #[test]
    fn agents_waiting_for_one_reset_go_one_after_another() {
        assert_eq!(due_at(RESET, 0), RESET + GRACE_SECS);
        assert_eq!(due_at(RESET, 2), RESET + GRACE_SECS + 2 * STAGGER_SECS);
    }

    fn store() -> (tempfile::TempDir, Store) {
        let parent = concat!(env!("CARGO_MANIFEST_DIR"), "/../target");
        std::fs::create_dir_all(parent).unwrap();
        let dir = tempfile::tempdir_in(parent).unwrap();
        let store = Store::open(&dir.path().join("workspace.sqlite")).unwrap();
        (dir, store)
    }
    fn stop(turn: &str, resets_at: i64, account: &str) -> Stop {
        Stop { turn_id: turn.into(), session_id: "s1".into(), resets_at, limit_type: Some("five_hour".into()), account: account.into() }
    }

    #[test]
    fn off_by_default_on_per_agent_once_per_turn_and_staggered_per_account() {
        let (_dir, store) = store();
        assert_eq!(store.auto_continue("a").unwrap(), (false, None, false));
        assert_eq!(store.arm_quota_resume("a", &stop("t1", RESET, "me"), 0).unwrap(), None, "off by default: nothing armed");
        store.set_auto_continue(Some("a"), Some(true)).unwrap();
        store.set_auto_continue(Some("b"), Some(true)).unwrap();
        store.set_auto_continue(None, Some(true)).unwrap();
        store.set_auto_continue(Some("d"), Some(false)).unwrap();
        assert_eq!(store.auto_continue("c").unwrap(), (true, None, true), "the workspace default");
        assert_eq!(store.auto_continue("d").unwrap(), (true, Some(false), false), "an Agent's own choice wins");
        let a = store.arm_quota_resume("a", &stop("t1", RESET, "me"), 0).unwrap().unwrap();
        assert_eq!((a.state.as_str(), a.attempt, a.due_at), ("waiting", 1, due_at(RESET, 0)));
        assert_eq!(store.arm_quota_resume("a", &stop("t1", RESET, "me"), 0).unwrap(), None, "one intent per failed turn");
        let b = store.arm_quota_resume("b", &stop("u1", RESET, "me"), 0).unwrap().unwrap();
        let c = store.arm_quota_resume("c", &stop("v1", RESET, "other"), 0).unwrap().unwrap();
        assert_eq!((b.due_at, c.due_at), (due_at(RESET, 1), due_at(RESET, 0)), "staggered within one account only");
        assert_eq!(store.arm_quota_resume("d", &stop("w1", RESET, "me"), 0).unwrap(), None);
        // Claiming: only a due intent, only once.
        assert!(!store.claim_quota_resume(&a.id, false, RESET).unwrap(), "not due yet");
        assert!(store.claim_quota_resume(&a.id, false, a.due_at).unwrap());
        assert!(!store.claim_quota_resume(&a.id, false, a.due_at).unwrap(), "claimed once");
        assert!(!store.claim_quota_resume(&a.id, true, a.due_at).unwrap(), "also by the user");
        assert!(store.move_quota_resume(&a.id, "sending", "sent", None, Some("t2"), 2).unwrap());
        // The continuation stopped again: the next attempt, for a later reset
        // only; also while its intent is still sending (the turn not yet named).
        let mut sending = store.arm_quota_resume("e", &stop("x1", RESET, "me"), 0);
        if sending.as_ref().unwrap().is_none() {
            store.set_auto_continue(Some("e"), Some(true)).unwrap();
            sending = store.arm_quota_resume("e", &stop("x1", RESET, "me"), 0);
        }
        let first = sending.unwrap().unwrap();
        store.claim_quota_resume(&first.id, false, first.due_at).unwrap();
        let unnamed = store.arm_quota_resume("e", &stop("x2", RESET + 18_000, "me"), 2).unwrap().unwrap();
        assert_eq!(unnamed.attempt, 2, "a stop while its continue is sending is that continue's");
        let next = store.arm_quota_resume("a", &stop("t2", RESET + 18_000, "me"), 3).unwrap().unwrap();
        assert_eq!((next.state.as_str(), next.attempt), ("waiting", 2));
        store.move_quota_resume(&next.id, "waiting", "sent", None, Some("t3"), 4).unwrap();
        let same = store.arm_quota_resume("a", &stop("t3", RESET + 18_000, "me"), 5).unwrap().unwrap();
        assert_eq!((same.state.as_str(), same.reason.as_deref()), ("failed", Some("Claude reported no later reset; continue by hand")));
        // The user's "Continue now" before the reset, which Claude refused
        // with the same reset: the automatic continue waits again, as the
        // same attempt, and its timer claims it when due.
        let early = store.arm_quota_resume("f", &stop("y1", RESET, "me"), 6).unwrap().unwrap();
        assert!(store.claim_quota_resume(&early.id, true, 7).unwrap(), "the user need not wait until it is due");
        store.move_quota_resume(&early.id, "sending", "sent", None, Some("y2"), 8).unwrap();
        assert!(store.quota_resume(&early.id).unwrap().unwrap().by_user);
        let still = store.arm_quota_resume("f", &stop("y2", RESET, "me"), 9).unwrap().unwrap();
        assert_eq!((still.state.as_str(), still.attempt, still.resets_at, still.by_user), ("waiting", 1, RESET, false));
        assert!(store.claim_quota_resume(&still.id, false, still.due_at).unwrap());
    }

    #[test]
    fn a_waiting_intent_does_not_send_after_new_input_a_closed_agent_or_another_session() {
        let i = Intent { id: "i".into(), agent_id: "a".into(), turn_id: "t1".into(), session_id: "s1".into(), resets_at: RESET,
            limit_type: None, attempt: 1, due_at: RESET + 60, state: "waiting".into(), reason: None, sent_turn: None, by_user: false };
        let d = detail(failed(1_000), rejected(), 2_000);
        assert_eq!(cancel_reason(&d, &i, true), None);
        assert_eq!(cancel_reason(&d, &i, false), Some("Automatic continue was turned off"));
        let mut newer = d.clone();
        newer.turns.push(json!({"id":"t2","status":"completed","items":[]}));
        assert_eq!(cancel_reason(&newer, &i, true), Some("Something newer was sent to the agent"));
        let mut closed = d.clone();
        closed.agent.closed_at = Some("now".into());
        assert_eq!(cancel_reason(&closed, &i, true), Some("The agent was closed"));
        let mut other = d.clone();
        other.agent.claude_session_id = Some("s2".into());
        assert_eq!(cancel_reason(&other, &i, true), Some("The Claude session changed"));
    }
}
