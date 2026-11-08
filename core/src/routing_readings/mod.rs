//! Routing readings (YN-34 S2a). These are the facts routing (S3) decides with, as
//! Core last observed them:
//! - **Time windows:** a weekly schedule, in UTC or the Core host's local time,
//!   and the built-in DeepSeek peak.
//! - **Daily API spend:** the spend of executors started with a routing key.
//!   It is what their harness reports: OpenCode's `cost` of each answer, and
//!   the increase in Claude Code's `total_cost_usd`, a running total of its
//!   session. That is an estimate, not a bill.
//!
//! Account quotas follow in S2b. Nothing here runs a model or calls a network
//! service, and no record holds a key's value: spend is counted by key id.
use crate::{routing_launch::RuntimeProfile, store::Store};
use anyhow::{ensure, Result};
use chrono::{DateTime, Datelike, Duration, Local, NaiveDate, Timelike, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub mod quota;
pub mod routes;

/// Where a schedule's days and times are read: UTC, or the Core host's local time.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
pub enum Zone {
    #[serde(rename = "UTC")]
    Utc,
    #[serde(rename = "local")]
    Local,
}

/// A weekly schedule, made of slots. `days` run from 1 (Monday) to 7 (Sunday).
/// `from` is inclusive and `to` exclusive, both `HH:MM`, and `to` may be
/// `24:00`. A slot whose `to` is not after its `from` runs past midnight into
/// the next day.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Schedule {
    pub time_zone: Zone,
    pub slots: Vec<Slot>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Slot {
    pub days: Vec<u8>,
    pub from: String,
    pub to: String,
}

/// The built-in schedules, by id. `deepseek-peak` is DeepSeek's peak hours,
/// UTC Monday to Friday 01:00–04:00 and 06:00–10:00. Holidays are counted as
/// working days, as the user decided. Off-peak is outside this schedule.
pub fn builtin(id: &str) -> Option<Schedule> {
    let weekdays = vec![1, 2, 3, 4, 5];
    match id {
        "deepseek-peak" => Some(Schedule {
            time_zone: Zone::Utc,
            slots: vec![
                Slot { days: weekdays.clone(), from: "01:00".into(), to: "04:00".into() },
                Slot { days: weekdays, from: "06:00".into(), to: "10:00".into() },
            ],
        }),
        _ => None,
    }
}

pub const BUILTIN: &[&str] = &["deepseek-peak"];

fn minutes(text: &str, end: bool) -> Result<u32> {
    let parsed = text.split_once(':').and_then(|(h, m)| {
        (h.len() == 2 && m.len() == 2).then(|| Some((h.parse::<u32>().ok()?, m.parse::<u32>().ok()?))).flatten()
    });
    match parsed {
        Some((24, 0)) if end => Ok(24 * 60),
        Some((h, m)) if h < 24 && m < 60 => Ok(h * 60 + m),
        _ => anyhow::bail!("A time is HH:MM, from 00:00 to 23:59 (24:00 for an end): {text:?}"),
    }
}

impl Schedule {
    /// Checks a schedule as a save takes it.
    pub fn check(&self) -> Result<()> {
        ensure!(!self.slots.is_empty() && self.slots.len() <= 16, "A schedule has 1 to 16 slots");
        for (n, slot) in self.slots.iter().enumerate() {
            ensure!(!slot.days.is_empty() && slot.days.iter().all(|d| (1..=7).contains(d)),
                "slots[{n}].days: each day is 1 (Monday) to 7 (Sunday)");
            let mut days = slot.days.clone();
            days.sort_unstable();
            days.dedup();
            ensure!(days.len() == slot.days.len(), "slots[{n}].days: each day once");
            let (from, to) = (minutes(&slot.from, false)?, minutes(&slot.to, true)?);
            ensure!(from != to, "slots[{n}]: a slot's from and to differ");
        }
        Ok(())
    }

    /// Whether `at` falls inside one of its slots.
    pub fn inside(&self, at: DateTime<Utc>) -> bool {
        let (weekday, minute) = match self.time_zone {
            Zone::Utc => (at.weekday().number_from_monday() as u8, at.hour() * 60 + at.minute()),
            Zone::Local => {
                let local = at.with_timezone(&Local);
                (local.weekday().number_from_monday() as u8, local.hour() * 60 + local.minute())
            }
        };
        let yesterday = if weekday == 1 { 7 } else { weekday - 1 };
        self.slots.iter().any(|slot| {
            let (Ok(from), Ok(to)) = (minutes(&slot.from, false), minutes(&slot.to, true)) else { return false };
            if from < to {
                slot.days.contains(&weekday) && (from..to).contains(&minute)
            } else {
                // Past midnight: from `from` on its day, and up to `to` on the next.
                (slot.days.contains(&weekday) && minute >= from) || (slot.days.contains(&yesterday) && minute < to)
            }
        })
    }

    /// When `inside` next changes after `at`, to the minute, within eight
    /// days. None when it never changes: always, or never, inside.
    pub fn changes_at(&self, at: DateTime<Utc>) -> Option<DateTime<Utc>> {
        let now = self.inside(at);
        let start = at.with_second(0)?.with_nanosecond(0)? + Duration::minutes(1);
        (0..8 * 24 * 60).map(|n| start + Duration::minutes(n)).find(|t| self.inside(*t) != now)
    }
}

/// A preset as the readings offer it: its schedule, and where it stands now.
pub fn schedule_now(schedule: &Schedule, at: DateTime<Utc>) -> Value {
    serde_json::json!({"schedule": schedule, "inside": schedule.inside(at), "changesAt": schedule.changes_at(at).map(|t| t.to_rfc3339())})
}

/// When the Core host's local day after `day` begins, in UTC.
pub fn day_ends(day: NaiveDate) -> Option<DateTime<Utc>> {
    let next = day.succ_opt()?.and_hms_opt(0, 0, 0)?;
    next.and_local_timezone(Local).earliest().map(|t| t.with_timezone(&Utc))
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    // Kept after its Agent is deleted: what was spent was spent that day.
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS routing_spend(
            agent_id TEXT NOT NULL,
            entry TEXT NOT NULL,
            day TEXT NOT NULL,
            key_id TEXT NOT NULL,
            usd REAL NOT NULL,
            source TEXT NOT NULL,
            at TEXT NOT NULL,
            PRIMARY KEY(agent_id, entry));
        CREATE INDEX IF NOT EXISTS routing_spend_day ON routing_spend(day);
        CREATE TABLE IF NOT EXISTS routing_spend_totals(
            agent_id TEXT PRIMARY KEY,
            source TEXT NOT NULL,
            total REAL NOT NULL,
            at TEXT NOT NULL);",
    )?;
    quota::migrate(db)
}

/// The Core host's local day, as spend is counted.
pub fn today() -> NaiveDate {
    Local::now().date_naive()
}

/// One day's spend: the total and each key's part, in USD.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DaySpend {
    pub day: String,
    pub total_usd: f64,
    pub by_key: BTreeMap<String, f64>,
}

impl Store {
    /// Counts what one turn or step of Agent `agent` cost, once, if it runs
    /// on a routing API key (an ApiKey runtime profile). Answers whether it
    /// was counted now. Days older than 40 are dropped.
    pub(crate) fn record_spend(&self, agent: &str, entry: &str, usd: f64, source: &str, day: NaiveDate) -> Result<bool> {
        let Some(RuntimeProfile::ApiKey { key_id }) = self.runtime_profile(agent)? else { return Ok(false) };
        let db = self.db.write()?;
        let added = db.execute(
            "INSERT OR IGNORE INTO routing_spend(agent_id, entry, day, key_id, usd, source, at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![agent, entry, day.to_string(), key_id, usd, source, Utc::now().to_rfc3339()],
        )?;
        db.execute("DELETE FROM routing_spend WHERE day < ?1", [(day - Duration::days(40)).to_string()])?;
        Ok(added == 1)
    }

    /// Counts what Agent `agent` spent since its harness last reported a running
    /// total, once per `entry`, if it runs on a routing API key. Claude Code's
    /// `total_cost_usd` is such a total, across the turns of its session:
    /// - the increase since the last total counts. The last total is kept across
    ///   restarts, so a resumed session, whose first total already holds its
    ///   earlier turns, counts only what is new;
    /// - a total below the last (a `/clear`, or a new session) counts from zero;
    /// - an entry already counted changes nothing.
    ///
    /// Answers what it counted now. A zero total (a crashed turn's) never
    /// reaches here: `usd` drops it, and the last total stays.
    pub(crate) fn record_running_spend(&self, agent: &str, entry: &str, total: f64, source: &str, day: NaiveDate) -> Result<Option<f64>> {
        use rusqlite::OptionalExtension;
        let Some(RuntimeProfile::ApiKey { key_id }) = self.runtime_profile(agent)? else { return Ok(None) };
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        if tx.query_row("SELECT 1 FROM routing_spend WHERE agent_id=?1 AND entry=?2", [agent, entry], |_| Ok(())).optional()?.is_some() {
            return Ok(None);
        }
        let last: Option<f64> = tx.query_row("SELECT total FROM routing_spend_totals WHERE agent_id=?1", [agent], |r| r.get(0)).optional()?;
        let spent = match last {
            Some(last) if total >= last => total - last,
            _ => total,
        };
        let at = Utc::now().to_rfc3339();
        tx.execute(
            "INSERT INTO routing_spend_totals(agent_id, source, total, at) VALUES(?1, ?2, ?3, ?4)
             ON CONFLICT(agent_id) DO UPDATE SET source=excluded.source, total=excluded.total, at=excluded.at",
            params![agent, source, total, at],
        )?;
        tx.execute(
            "INSERT INTO routing_spend(agent_id, entry, day, key_id, usd, source, at) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![agent, entry, day.to_string(), key_id, spent, source, at],
        )?;
        tx.execute("DELETE FROM routing_spend WHERE day < ?1", [(day - Duration::days(40)).to_string()])?;
        tx.commit()?;
        Ok(Some(spent))
    }

    pub(crate) fn spend_on(&self, day: NaiveDate) -> Result<DaySpend> {
        let db = self.db.read()?;
        let mut statement = db.prepare("SELECT key_id, SUM(usd) FROM routing_spend WHERE day=?1 GROUP BY key_id ORDER BY key_id")?;
        let by_key: BTreeMap<String, f64> = statement.query_map([day.to_string()], |r| Ok((r.get(0)?, r.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        Ok(DaySpend { day: day.to_string(), total_usd: by_key.values().fold(0.0, |total, usd| total + usd), by_key })
    }

    /// Whether `entry` of `agent` was already counted (for tests and callers that ask first).
    #[cfg(test)]
    pub(crate) fn spend_counted(&self, agent: &str, entry: &str) -> Result<bool> {
        use rusqlite::OptionalExtension;
        let db = self.db.read()?;
        Ok(db.query_row("SELECT 1 FROM routing_spend WHERE agent_id=?1 AND entry=?2", [agent, entry], |_| Ok(())).optional()?.is_some())
    }
}

/// A cost as a harness reports it, in USD, when it is a plausible positive amount.
fn usd(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && *n > 0.0 && *n < 10_000.0)
}

/// What an OpenCode answer cost: a finished assistant message's `cost`, keyed by its id.
pub fn opencode_spend(info: &Value) -> Option<(String, f64)> {
    if info["role"] != "assistant" || info["time"]["completed"].is_null() {
        return None;
    }
    Some((format!("opencode:{}", info["id"].as_str()?), usd(&info["cost"])?))
}

/// A Claude Code result's running total, `total_cost_usd`, keyed by the result's uuid, else its turn.
/// It is the session's total so far, not the turn's: `count_running` counts its increase.
pub fn claude_spend(event: &Value, turn: Option<&str>) -> Option<(String, f64)> {
    let key = event["uuid"].as_str().or(turn)?;
    Some((format!("claude:{key}"), usd(&event["total_cost_usd"])?))
}

/// Counts an entry's spend for Agent `agent`, never failing the event it came with.
pub(crate) fn count(store: &Store, agent: &str, spend: Option<(String, f64)>, source: &str) {
    let Some((entry, usd)) = spend else { return };
    if let Err(error) = store.record_spend(agent, &entry, usd, source, today()) {
        eprintln!("Workspace could not count {agent}'s routing spend: {error:#}");
    }
}

/// Counts the increase in a running total of Agent `agent` (`record_running_spend`), never failing the event it came with.
pub(crate) fn count_running(store: &Store, agent: &str, total: Option<(String, f64)>, source: &str) {
    let Some((entry, total)) = total else { return };
    if let Err(error) = store.record_running_spend(agent, &entry, total, source, today()) {
        eprintln!("Workspace could not count {agent}'s routing spend: {error:#}");
    }
}

#[cfg(test)]
mod tests;
