//! Subscription quotas (YN-34 S2b): what is left of each account's 5-hour and
//! weekly windows, read in the background while the routing policy needs them.
//!
//! - **claude-swap accounts** come from `cswap list --json`.
//! - **Codex** quotas are read per home: the host's own login and each listed
//!   Codex home. Each read starts a model-less `codex app-server` in that home
//!   and asks `account/read`, then `account/rateLimits/read` (a ChatGPT
//!   login's limits; an API-key login has none).
//!
//! Each reading is kept with its time, and the readings route answers from
//! what is kept. Nothing here runs a model. Readings come back to Core without
//! emails: an account is its number and fingerprint.
use crate::{routing_accounts, store::Store, workspace::Workspace};
use anyhow::Result;
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{sync::{Arc, OnceLock}, time::Duration};

/// How often the background refresh reads, while the policy needs readings.
pub const EVERY: Duration = Duration::from_secs(300);
/// A reading older than this is stale: routing reads it as unknown.
pub const STALE_AFTER_SECONDS: i64 = 600;
const CODEX_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Default)]
pub(crate) struct State {
    started: OnceLock<()>,
}

pub(crate) fn migrate(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS routing_quotas(
            source TEXT PRIMARY KEY,
            reading TEXT NOT NULL,
            observed_at TEXT NOT NULL);",
    )?;
    Ok(())
}

/// Which quotas the policy needs read: claude-swap's, and Codex's (the host
/// login and each listed home). None while routing is off.
#[derive(Debug, Default, PartialEq)]
pub struct Needs {
    pub cswap: bool,
    pub codex: bool,
}

pub fn needs(policy: &Value) -> Needs {
    let mut needs = Needs::default();
    if policy["enabled"] != true {
        return needs;
    }
    for c in policy["candidates"].as_array().into_iter().flatten().filter(|c| c["enabled"] == true) {
        let kind = c["credential"]["kind"].as_str().unwrap_or_default();
        let quota = c["conditions"].as_array().into_iter().flatten().any(|k| k["kind"] == "quota");
        match c["harness"].as_str() {
            Some("claude") if kind == "pool" || (kind == "login" && quota) => needs.cswap = true,
            Some("codex") if quota && matches!(kind, "login" | "codexHome") => needs.codex = true,
            _ => {}
        }
    }
    needs
}

fn unknown(code: &str, message: impl Into<String>, message_zh: impl Into<String>) -> Value {
    json!({"code": code, "message": message.into(), "messageZh": message_zh.into()})
}

fn epoch(seconds: &Value) -> Option<String> {
    Utc.timestamp_opt(seconds.as_i64()?, 0).single().map(|t| t.to_rfc3339())
}

/// A Codex window as the readings show it: the share left and when it resets.
fn codex_window(v: &Value) -> Value {
    let left = v["usedPercent"].as_f64().filter(|n| n.is_finite()).map(|used| (100.0 - used).clamp(0.0, 100.0));
    json!({"leftPct": left, "resetsAt": epoch(&v["resetsAt"])})
}

/// Codex's limits answer as `{fiveHour, week}`, taking the `codex` limit and
/// its windows by their length: about five hours, about a week.
pub fn codex_windows(limits: &Value) -> Value {
    let bucket = limits["rateLimitsByLimitId"]["codex"].as_object().map(|_| &limits["rateLimitsByLimitId"]["codex"])
        .unwrap_or(&limits["rateLimits"]);
    let mut out = json!({});
    for (n, name) in ["primary", "secondary"].iter().enumerate() {
        let w = &bucket[name];
        if !w.is_object() {
            continue;
        }
        let minutes = w["windowDurationMins"].as_i64();
        let slot = match minutes {
            Some(m) if m <= 12 * 60 => "fiveHour",
            Some(m) if m >= 5 * 24 * 60 => "week",
            _ if n == 0 => "fiveHour",
            _ => "week",
        };
        out[slot] = codex_window(w);
    }
    out
}

/// Reads one Codex home's quota: `env` is its CODEX_HOME, empty for the host's own login.
async fn codex_quota(program: &str, env: &[(String, crate::routing_keys::Secret)]) -> Value {
    let read = async {
        let session = crate::codex_sessions::ReadSession::open_with(program, env).await?;
        let account = session.0.request_within("account/read", json!({"refreshToken": false}), Duration::from_secs(10)).await;
        let limits = match &account {
            Ok(a) if a["account"]["type"] == "chatgpt" => Some(session.0.request_within("account/rateLimits/read", Value::Null, Duration::from_secs(10)).await),
            _ => None,
        };
        let _ = session.close().await;
        anyhow::Ok((account?, limits))
    };
    match tokio::time::timeout(CODEX_TIMEOUT, read).await {
        Err(_) => json!({"unknown": unknown("codexTimeout", "Codex did not answer in time", "Codex 没有及时回答")}),
        Ok(Err(_)) => json!({"unknown": unknown("codexUnreadable", "Codex could not be asked for its account", "无法向 Codex 读取账号")}),
        Ok(Ok((account, None))) if account["account"].is_object() => json!({"unknown": unknown("notSubscription",
            "This Codex login is not a ChatGPT subscription: it has no quota", "这个 Codex 登录不是 ChatGPT 订阅，没有额度")}),
        Ok(Ok((_, None))) => json!({"unknown": unknown("notSignedIn", "This Codex home is not signed in", "这个 Codex 目录没有登录")}),
        Ok(Ok((_, Some(Err(_))))) => json!({"unknown": unknown("limitsUnreadable", "Codex did not give its limits", "Codex 没有给出额度")}),
        Ok(Ok((_, Some(Ok(limits))))) => codex_windows(&limits),
    }
}

impl Store {
    fn put_quota(&self, source: &str, reading: &Value, at: DateTime<Utc>) -> Result<()> {
        self.db.write()?.execute(
            "INSERT INTO routing_quotas(source, reading, observed_at) VALUES(?1, ?2, ?3)
             ON CONFLICT(source) DO UPDATE SET reading=excluded.reading, observed_at=excluded.observed_at",
            params![source, reading.to_string(), at.to_rfc3339()],
        )?;
        Ok(())
    }

    /// Drops the Codex readings of homes no longer listed: `codex:<id>` for an id not in `ids`.
    fn keep_codex_quotas(&self, ids: &[String]) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let sources: Vec<String> = tx.prepare("SELECT source FROM routing_quotas WHERE source LIKE 'codex:%'")?
            .query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        for source in sources {
            if !source.strip_prefix("codex:").is_some_and(|id| ids.iter().any(|kept| kept == id)) {
                tx.execute("DELETE FROM routing_quotas WHERE source=?1", [&source])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Every kept reading: (source, reading, observedAt).
    pub(crate) fn quotas(&self) -> Result<Vec<(String, Value, String)>> {
        let db = self.db.read()?;
        let mut statement = db.prepare("SELECT source, reading, observed_at FROM routing_quotas ORDER BY source")?;
        let rows = statement.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows.into_iter().filter_map(|(source, reading, at)| Some((source, serde_json::from_str(&reading).ok()?, at))).collect())
    }
}

/// Whether a reading observed at `at` is stale now.
pub fn stale(at: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(at).map_or(true, |t| (now - t.with_timezone(&Utc)).num_seconds() > STALE_AFTER_SECONDS)
}

/// The kept readings in the shape of `GET /api/routing/readings`: `{cswap, codex}`.
pub fn view(kept: &[(String, Value, String)], now: DateTime<Utc>) -> (Value, Value) {
    let mut cswap = Value::Null;
    let mut codex = Vec::new();
    for (source, reading, at) in kept {
        if source == "cswap" {
            let mut r = reading.clone();
            r["observedAt"] = at.clone().into();
            r["stale"] = stale(at, now).into();
            cswap = r;
        } else if let Some(home) = source.strip_prefix("codex:") {
            let mut r = reading.clone();
            r["home"] = home.into();
            r["observedAt"] = at.clone().into();
            r["source"] = "codex".into();
            r["stale"] = stale(at, now).into();
            codex.push(r);
        }
    }
    (cswap, Value::Array(codex))
}

impl Workspace {
    /// Reads the quotas `needs` names now, and keeps each with its time.
    pub(crate) async fn refresh_quotas(self: &Arc<Self>, needs: &Needs) -> Result<()> {
        if needs.cswap {
            let command = self.stored(|store| store.cswap_settings()).await?.command;
            let at = Utc::now();
            let reading = match routing_accounts::cswap_accounts(&command).await {
                Ok(accounts) => json!({"accounts": accounts.iter().map(|a| {
                    let mut row = json!({"number": a.number, "fingerprint": a.fingerprint, "active": a.active, "source": "cswap"});
                    if let Some(w) = &a.five_hour { row["fiveHour"] = json!(w); }
                    if let Some(w) = &a.week { row["week"] = json!(w); }
                    if a.usage_status.as_deref() != Some("ok") || (a.five_hour.is_none() && a.week.is_none()) {
                        let status = a.usage_status.clone().unwrap_or_else(|| "none".into());
                        row["unknown"] = unknown(&format!("usage:{status}"), format!("claude-swap has no usage for this account ({status})"),
                            format!("claude-swap 没有这个账号的用量（{status}）"));
                    }
                    row
                }).collect::<Vec<_>>()}),
                Err(why) => json!({"accounts": [], "unavailable": why}),
            };
            let kept = reading.clone();
            self.stored(move |store| store.put_quota("cswap", &kept, at)).await?;
        }
        if needs.codex {
            let homes = self.stored(|store| store.codex_homes()).await?;
            let mut targets: Vec<(String, Vec<(String, crate::routing_keys::Secret)>)> = vec![("login".into(), Vec::new())];
            // `login` is the host's own login, never a listed home's id (check_homes refuses it).
            for home in homes.into_iter().filter(|h| h.id != "login") {
                targets.push((home.id, vec![("CODEX_HOME".into(), crate::routing_keys::Secret::new(home.home))]));
            }
            let ids: Vec<String> = targets.iter().map(|(id, _)| id.clone()).collect();
            self.stored(move |store| store.keep_codex_quotas(&ids)).await?;
            for (id, env) in targets {
                let at = Utc::now();
                let reading = codex_quota(&self.program, &env).await;
                self.stored(move |store| store.put_quota(&format!("codex:{id}"), &reading, at)).await?;
            }
        }
        Ok(())
    }

    /// Reads what the policy needs every five minutes, while it needs any.
    pub fn start_routing_quotas(self: &Arc<Self>) {
        if self.routing_quotas.started.set(()).is_err() {
            return;
        }
        let weak = Arc::downgrade(self);
        tokio::spawn(async move {
            loop {
                let Some(ws) = weak.upgrade() else { break };
                let needs = ws.stored(|store| store.routing_policy()).await.map(|p| needs(&p.policy)).unwrap_or_default();
                if needs != Needs::default() {
                    if let Err(error) = ws.refresh_quotas(&needs).await {
                        eprintln!("Workspace could not read routing quotas: {error:#}");
                    }
                }
                drop(ws);
                tokio::time::sleep(EVERY).await;
            }
        });
    }
}

#[cfg(test)]
#[path = "quota_tests.rs"]
mod tests;
