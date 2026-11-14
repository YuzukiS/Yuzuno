//! The routing policy (YN-34 S3a): the Workspace's ordered list of executor
//! candidates, each a harness, a model and an account or key, with conditions.
//! The shapes are in docs/executor-routing.md ("The policy").
//!
//! - It is kept in `workspace_meta` under `executors.routing` as
//!   `{version, updatedAt, policy}`.
//! - The policy is kept as the JSON that was saved. A field this Core does not
//!   know, on the policy, a candidate or a condition, is kept as it was. So is
//!   a credential or condition of a kind a later Core added; routing (S3b)
//!   reads such a kind as unknown.
//! - A save is checked strictly. Each refusal names the field's path.
//! - A save replaces the whole policy, against the version read.
//! - A quota condition's `fiveHourLeftPct` is retired (YN-60): a page from
//!   before may still send it, and a save takes it and drops it; a read shows
//!   a saved policy without it (`without_five_hour`).
//!
//! Only the user's own browser writes it (routes.rs). Choosing an executor by
//! it is S3b.
use crate::{routing_keys::Provider, store::Store};
use anyhow::Result;
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashSet;

pub mod dispatch;
pub mod evaluate;
pub(crate) mod left;
pub(crate) mod moves;
pub mod routes;

pub const KEY: &str = "executors.routing";
pub const MAX_CANDIDATES: usize = 8;
const MAX_CONDITIONS: usize = 16;
const MAX_POOL: usize = 16;
pub const HARNESSES: &[&str] = &["claude", "codex", "opencode"];

/// The policy as stored, and its version (0 before the first save).
#[derive(Clone, Debug, PartialEq)]
pub struct Stored {
    pub version: i64,
    pub updated_at: Option<String>,
    pub policy: Value,
}

impl Stored {
    pub fn view(&self) -> Value {
        json!({"version": self.version, "updatedAt": self.updated_at, "limits": {"candidates": MAX_CANDIDATES},
            "policy": without_five_hour(&self.policy, false)})
    }
}

/// A quota condition's 5-hour share, retired by the user on 2026-11-09 (YN-60):
/// Claude and Codex have no 5-hour quota now, and Core reads none.
pub const FIVE_HOUR: &str = "fiveHourLeftPct";

/// `policy` without any quota condition's 5-hour share. A condition left with no
/// share at all is dropped when `drop_emptied` (a save: it was no condition), and
/// kept as `{kind: "quota"}` otherwise (a read: the page marks it to fix).
pub fn without_five_hour(policy: &Value, drop_emptied: bool) -> Value {
    let mut policy = policy.clone();
    for candidate in policy["candidates"].as_array_mut().into_iter().flatten() {
        let Some(conditions) = candidate.get_mut("conditions").and_then(Value::as_array_mut) else { continue };
        conditions.retain_mut(|c| {
            let Some(map) = c.as_object_mut().filter(|m| m.get("kind").is_some_and(|k| k == "quota")) else { return true };
            if map.remove(FIVE_HOUR).is_none() {
                return true;
            }
            !drop_emptied || map.get("weekLeftPct").is_some_and(|w| !w.is_null())
        });
    }
    policy
}

/// The policy before any save: routing off.
pub fn empty() -> Value {
    json!({"enabled": false, "candidates": [], "whenNone": "wait"})
}

/// Why a policy is refused, and where.
#[derive(Clone, Debug, PartialEq)]
pub struct Invalid {
    pub path: String,
    pub error: String,
}

fn refuse<T>(path: impl Into<String>, error: impl Into<String>) -> Result<T, Invalid> {
    Err(Invalid { path: path.into(), error: error.into() })
}

/// What a check needs to know of this Core: its routing keys' providers by id,
/// and its listed Codex homes.
pub struct Known {
    pub keys: Vec<(String, Provider)>,
    pub codex_homes: Vec<String>,
}

fn object<'a>(value: &'a Value, path: &str, what: &str) -> Result<&'a Map<String, Value>, Invalid> {
    match value.as_object() {
        Some(map) => Ok(map),
        None => refuse(path, format!("{what} is an object")),
    }
}

fn boolean(map: &Map<String, Value>, path: &str, field: &str, default: Option<bool>) -> Result<bool, Invalid> {
    match (map.get(field), default) {
        (Some(Value::Bool(b)), _) => Ok(*b),
        (None, Some(default)) => Ok(default),
        _ => refuse(format!("{path}{field}"), format!("{field} is true or false")),
    }
}

fn usd(map: &Map<String, Value>, path: &str, field: &str) -> Result<Option<f64>, Invalid> {
    match map.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => match v.as_f64() {
            Some(n) if n > 0.0 && n <= 10_000.0 => Ok(Some(n)),
            _ => refuse(format!("{path}{field}"), "An amount in USD is above 0 and at most 10000"),
        },
    }
}

fn plain_id(text: &str) -> bool {
    !text.is_empty() && text.len() <= 48 && text.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// Checks a policy as a save takes it.
pub fn check(policy: &Value, known: &Known) -> Result<(), Invalid> {
    let map = object(policy, "", "The policy")?;
    boolean(map, "", "enabled", None)?;
    match map.get("whenNone") {
        None => {}
        Some(v) if v == "wait" => {}
        Some(_) => return refuse("whenNone", "whenNone is \"wait\" in this version"),
    }
    usd(map, "", "dailyApiCapUsd")?;
    let candidates = match map.get("candidates") {
        Some(Value::Array(list)) => list,
        _ => return refuse("candidates", "candidates is a list"),
    };
    if candidates.len() > MAX_CANDIDATES {
        return refuse("candidates", format!("At most {MAX_CANDIDATES} candidates"));
    }
    let mut ids = HashSet::new();
    for (n, candidate) in candidates.iter().enumerate() {
        let path = format!("candidates[{n}].");
        let c = object(candidate, &format!("candidates[{n}]"), "A candidate")?;
        let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
        if !plain_id(id) {
            return refuse(format!("{path}id"), "A candidate's id is 1 to 48 of a-z, 0-9 and -");
        }
        if !ids.insert(id) {
            return refuse(format!("{path}id"), format!("The id {id} is used twice"));
        }
        match c.get("label") {
            None | Some(Value::Null) => {}
            Some(Value::String(label)) if label.chars().count() <= 60 && !label.chars().any(char::is_control) => {}
            Some(_) => return refuse(format!("{path}label"), "A label is at most 60 characters on one line"),
        }
        boolean(c, &path, "enabled", None)?;
        let harness = c.get("harness").and_then(Value::as_str).unwrap_or_default();
        if !HARNESSES.contains(&harness) {
            return refuse(format!("{path}harness"), "harness is claude, codex or opencode");
        }
        let model = match c.get("model") {
            None | Some(Value::Null) => "",
            Some(Value::String(m)) if m.len() <= 200 && !m.chars().any(|ch| ch.is_whitespace() || ch.is_control()) => m,
            Some(_) => return refuse(format!("{path}model"), "A model is a name of at most 200 characters, without spaces"),
        };
        if harness == "opencode" && !model.is_empty() && crate::opencode_agent::check_model_id(model).is_err() {
            return refuse(format!("{path}model"), "An OpenCode model is named <provider>/<model>, such as deepseek/deepseek-flash");
        }
        match c.get("reasoningEffort") {
            None | Some(Value::Null) => {}
            Some(Value::String(e)) if harness == "codex" && !e.is_empty() && e.len() <= 32 && e.bytes().all(|b| b.is_ascii_lowercase()) => {}
            Some(_) if harness != "codex" => return refuse(format!("{path}reasoningEffort"), "Only a Codex candidate takes a reasoning effort"),
            Some(_) => return refuse(format!("{path}reasoningEffort"), "A reasoning effort is a word such as high"),
        }
        match c.get("unknown") {
            None => {}
            Some(v) if v == "skip" || v == "pass" => {}
            Some(_) => return refuse(format!("{path}unknown"), "unknown is \"skip\" or \"pass\""),
        }
        // The tiers it serves (YN-70); unset serves both.
        match c.get("tiers") {
            None | Some(Value::Null) => {}
            Some(Value::Array(list)) if !list.is_empty()
                && list.iter().all(|t| t.as_str().is_some_and(|t| crate::executor_templates::TIERS.contains(&t)))
                && list.iter().collect::<HashSet<_>>().len() == list.len() => {}
            Some(_) => return refuse(format!("{path}tiers"), "tiers lists strong, fast or both, each once; leave it out to serve both"),
        }
        let credential = check_credential(c.get("credential").unwrap_or(&Value::Null), &format!("{path}credential"), harness, known)?;
        let none = Vec::new();
        let conditions = match c.get("conditions") {
            None => &none,
            Some(Value::Array(list)) if list.len() <= MAX_CONDITIONS => list,
            Some(_) => return refuse(format!("{path}conditions"), format!("conditions is a list of at most {MAX_CONDITIONS}")),
        };
        for (k, condition) in conditions.iter().enumerate() {
            check_condition(condition, &format!("{path}conditions[{k}]"), credential)?;
        }
    }
    Ok(())
}

/// Checks a credential for its harness; answers its kind.
fn check_credential<'a>(value: &'a Value, path: &str, harness: &str, known: &Known) -> Result<&'a str, Invalid> {
    let c = object(value, path, "A credential")?;
    let kind = c.get("kind").and_then(Value::as_str).unwrap_or_default();
    match kind {
        "login" => {}
        "pool" => {
            if harness != "claude" {
                return refuse(format!("{path}.kind"), "A claude-swap pool is for Claude Code candidates only");
            }
            if c.get("manager").and_then(Value::as_str) != Some("cswap") {
                return refuse(format!("{path}.manager"), "A pool's manager is \"cswap\"");
            }
            match c.get("accounts") {
                Some(v) if v == "all" => {}
                Some(Value::Array(list)) if !list.is_empty() && list.len() <= MAX_POOL && list.iter().all(|f| {
                    f.as_str().is_some_and(|f| f.len() == 16 && f.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
                }) => {}
                _ => return refuse(format!("{path}.accounts"), format!("accounts is \"all\" or 1 to {MAX_POOL} account fingerprints")),
            }
            match c.get("pick") {
                None => {}
                Some(v) if v == "mostRemaining" => {}
                Some(_) => return refuse(format!("{path}.pick"), "pick is \"mostRemaining\""),
            }
        }
        "apiKey" => {
            let id = c.get("keyId").and_then(Value::as_str).unwrap_or_default();
            let Some((_, provider)) = known.keys.iter().find(|(k, _)| k == id) else {
                return refuse(format!("{path}.keyId"), format!("No routing key is named {id:?}; add it first"));
            };
            let fits = match harness {
                "claude" => *provider == Provider::Anthropic,
                "codex" => *provider == Provider::Openai,
                _ => true,
            };
            if !fits {
                return refuse(format!("{path}.keyId"), format!("The key {id} is not one a {harness} candidate can use"));
            }
        }
        "codexHome" => {
            if harness != "codex" {
                return refuse(format!("{path}.kind"), "A Codex home is for Codex candidates only");
            }
            let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
            if !known.codex_homes.iter().any(|h| h == id) {
                return refuse(format!("{path}.id"), format!("No Codex home is listed as {id:?}"));
            }
        }
        // A later Core's kind is kept; routing reads it as unknown.
        other if plain_kind(other) => {}
        _ => return refuse(format!("{path}.kind"), "kind is login, pool, apiKey or codexHome"),
    }
    Ok(kind)
}

fn plain_kind(kind: &str) -> bool {
    !kind.is_empty() && kind.len() <= 32 && kind.bytes().all(|b| b.is_ascii_alphanumeric())
}

fn check_condition(value: &Value, path: &str, credential: &str) -> Result<(), Invalid> {
    let c = object(value, path, "A condition")?;
    let field = |name: &str| format!("{path}.{name}");
    match c.get("kind").and_then(Value::as_str).unwrap_or_default() {
        "timeWindow" => {
            if !matches!(c.get("inside"), Some(Value::Bool(_))) {
                return refuse(field("inside"), "inside is true or false");
            }
            let schedule: crate::routing_readings::Schedule = match c.get("schedule").map(|s| serde_json::from_value(s.clone())) {
                Some(Ok(schedule)) => schedule,
                _ => return refuse(field("schedule"), "A schedule is {timeZone: UTC or local, slots: [{days, from, to}]}"),
            };
            if let Err(error) = schedule.check() {
                return refuse(field("schedule"), format!("{error:#}"));
            }
            match c.get("minMinutesLeft") {
                None | Some(Value::Null) => {}
                Some(v) if v.as_u64().is_some_and(|n| (1..=1440).contains(&n)) => {}
                Some(_) => return refuse(field("minMinutesLeft"), "minMinutesLeft is 1 to 1440"),
            }
        }
        "quota" => {
            if !matches!(credential, "login" | "pool" | "codexHome") {
                return refuse(field("kind"), "A quota condition is for a login, a pool or a Codex home");
            }
            let week = match c.get("weekLeftPct") {
                None | Some(Value::Null) => false,
                Some(v) if v.as_f64().is_some_and(|n| (0.0..=100.0).contains(&n)) => true,
                Some(_) => return refuse(field("weekLeftPct"), "weekLeftPct is 0 to 100"),
            };
            // An older page's 5-hour share is taken here and dropped by the save (YN-60).
            if !week && c.get(FIVE_HOUR).is_none_or(Value::is_null) {
                return refuse(field("kind"), "A quota condition names weekLeftPct");
            }
        }
        "dailyApiCap" => {
            if credential != "apiKey" {
                return refuse(field("kind"), "A daily API cap is for an API-key candidate");
            }
            if usd(c, &format!("{path}."), "usd")?.is_none() {
                return refuse(field("usd"), "An amount in USD is above 0 and at most 10000");
            }
        }
        other if plain_kind(other) => {}
        _ => return refuse(field("kind"), "kind is timeWindow, quota or dailyApiCap"),
    }
    Ok(())
}

/// The stored policy, read on `db` (a dispatch's own transaction).
pub(crate) fn stored_in(db: &rusqlite::Connection) -> Result<Stored> {
    read(db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get(0)).optional()?)
}

/// The stored value's form: `{version, updatedAt, policy}`.
fn read(raw: Option<String>) -> Result<Stored> {
    let Some(raw) = raw else { return Ok(Stored { version: 0, updated_at: None, policy: empty() }) };
    let value: Value = serde_json::from_str(&raw)?;
    Ok(Stored {
        version: value["version"].as_i64().unwrap_or(0),
        updated_at: value["updatedAt"].as_str().map(str::to_owned),
        policy: if value["policy"].is_object() { value["policy"].clone() } else { empty() },
    })
}

impl Store {
    pub(crate) fn routing_policy(&self) -> Result<Stored> {
        let db = self.db.read()?;
        read(db.query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get(0)).optional()?)
    }

    /// Saves `policy` as the next version if `expected` is the version stored
    /// now. Otherwise answers Err with what is stored, saving nothing.
    pub(crate) fn save_routing_policy(&self, expected: i64, policy: Value) -> Result<Result<Stored, Stored>> {
        let mut writer = self.db.write()?;
        let tx = writer.transaction()?;
        let current = read(tx.query_row("SELECT value FROM workspace_meta WHERE key=?1", [KEY], |r| r.get(0)).optional()?)?;
        if current.version != expected {
            return Ok(Err(current));
        }
        let saved = Stored { version: current.version + 1, updated_at: Some(Utc::now().to_rfc3339()), policy };
        let text = json!({"version": saved.version, "updatedAt": saved.updated_at, "policy": saved.policy}).to_string();
        tx.execute("INSERT INTO workspace_meta(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![KEY, text])?;
        tx.commit()?;
        Ok(Ok(saved))
    }
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod e2e_tests;
