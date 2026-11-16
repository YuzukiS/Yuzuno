//! Subscription quotas (YN-34 S2b): what is left of each account's weekly
//! window, read in the background while the routing policy needs them. Only
//! the week is read (YN-60): Claude and Codex have no 5-hour quota now.
//!
//! - **claude-swap accounts** come from `cswap list --json`.
//! - **Codex** quotas are read per home: the host's own login and each listed
//!   Codex home. Each read starts a model-less `codex app-server` in that home
//!   and asks `account/read`, then `account/rateLimits/read` (a ChatGPT
//!   login's limits; an API-key login has none).
//!
//! - **Another machine's own logins** (YN-175), for a Claude Code or Codex
//!   `login` candidate with a quota condition that may run there: read on that
//!   machine through its SSH helper (remote.rs `quota`), its claude-swap's
//!   default-login account and its Codex login, one request per machine. A
//!   login there is that machine's own, so routing never judges it by this
//!   host's readings.
//!
//! Each reading is kept with its time, and the readings route answers from
//! what is kept. Nothing here runs a model. Readings come back to Core without
//! emails: an account is its number and fingerprint.
use crate::{remote::RemoteMachine, routing_accounts, store::Store, workspace::Workspace};
use anyhow::Result;
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::{collections::BTreeSet, sync::{Arc, OnceLock}, time::Duration};

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
/// login and each listed home), and on which registered machines their own
/// Claude Code and Codex logins (YN-175). None while routing is off.
#[derive(Debug, Default, PartialEq)]
pub struct Needs {
    pub cswap: bool,
    pub codex: bool,
    pub claude_machines: Machines,
    pub codex_machines: Machines,
}

/// The registered machines whose own login a policy needs read (YN-175).
#[derive(Clone, Debug, Default, PartialEq)]
pub enum Machines {
    #[default]
    None,
    /// Every registered machine: a candidate with no machine condition may run on any.
    All,
    /// These: the machines a candidate's machine conditions all name.
    Only(BTreeSet<String>),
}

impl Machines {
    /// Adds the machines other than this Core host that `candidate` may run on
    /// (routing_policy::evaluate `machine_allows`: each machine condition names it).
    fn add(&mut self, candidate: &Value) {
        let mut lists = candidate["conditions"].as_array().into_iter().flatten().filter(|c| c["kind"] == "machine")
            .map(|c| c["machines"].as_array().into_iter().flatten().filter_map(Value::as_str).filter(|m| *m != "local")
                .map(str::to_owned).collect::<BTreeSet<String>>());
        let Some(first) = lists.next() else {
            *self = Machines::All;
            return;
        };
        let allowed = lists.fold(first, |a, b| &a & &b);
        match self {
            Machines::All => {}
            Machines::None if allowed.is_empty() => {}
            Machines::None => *self = Machines::Only(allowed),
            Machines::Only(set) => set.extend(allowed),
        }
    }

    pub fn wants(&self, id: &str) -> bool {
        match self {
            Machines::None => false,
            Machines::All => true,
            Machines::Only(set) => set.contains(id),
        }
    }
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
        // YN-175: a login with a quota condition that limits (a week's share) on the
        // other machines it may run on, where it is that machine's own login.
        if kind == "login" && crate::routing_policy::evaluate::has_quota_condition(c) {
            match c["harness"].as_str() {
                Some("claude") => needs.claude_machines.add(c),
                Some("codex") => needs.codex_machines.add(c),
                _ => {}
            }
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

/// Codex's limits answer as `{week}`, taking the `codex` limit and its window
/// of about a week by its length. A shorter window, such as the 5-hour one
/// Codex had before, is not read (YN-60).
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
        let week = match minutes {
            Some(m) if m <= 12 * 60 => false,
            Some(m) if m >= 5 * 24 * 60 => true,
            _ => n == 1,
        };
        if week {
            out["week"] = codex_window(w);
        }
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
        Err(_) => json!({"unknown": codex_unknown("codexTimeout")}),
        Ok(Err(_)) => json!({"unknown": codex_unknown("codexUnreadable")}),
        Ok(Ok((account, None))) if account["account"].is_object() => json!({"unknown": codex_unknown("notSubscription")}),
        Ok(Ok((_, None))) => json!({"unknown": codex_unknown("notSignedIn")}),
        Ok(Ok((_, Some(Err(_))))) => json!({"unknown": codex_unknown("limitsUnreadable")}),
        Ok(Ok((_, Some(Ok(limits))))) => codex_windows(&limits),
    }
}

/// Why a Codex login's quota is unknown, as a reading says it, on this Core
/// host or another machine.
fn codex_unknown(code: &str) -> Value {
    match code {
        "codexTimeout" => unknown(code, "Codex did not answer in time", "Codex 没有及时回答"),
        "codexMissing" => unknown(code, "Codex is not found there", "那里找不到 Codex"),
        "notSubscription" => unknown(code, "This Codex login is not a ChatGPT subscription: it has no quota", "这个 Codex 登录不是 ChatGPT 订阅，没有额度"),
        "notSignedIn" => unknown(code, "This Codex home is not signed in", "这个 Codex 目录没有登录"),
        "limitsUnreadable" => unknown(code, "Codex did not give its limits", "Codex 没有给出额度"),
        _ => unknown("codexUnreadable", "Codex could not be asked for its account", "无法向 Codex 读取账号"),
    }
}

/// A reason as a machine's reading keeps it: the machine named first (YN-175).
fn on_machine(name: &str, why: Value) -> Value {
    unknown(why["code"].as_str().unwrap_or_default(), format!("{name}: {}", why["message"].as_str().unwrap_or_default()),
        format!("{name}：{}", why["messageZh"].as_str().unwrap_or_default()))
}

/// claude-swap's default-login account on the machine `name`, from the helper's
/// answer (remote_helper.py `cswap_quota`), as a reading keeps it: its week, or
/// why it is unknown, as `cswap_reading` says it for this host's.
pub(crate) fn machine_claude(name: &str, answer: &Value) -> Value {
    let part = |why: Value| json!({"unknown": why, "source": "cswap"});
    let failed = || part(unknown("cswapFailed", format!("{name}: cswap list gave no account list"), format!("{name}：cswap list 没有给出账号列表")));
    match answer["error"].as_str() {
        Some("cswapMissing") => return part(unknown("cswapMissing",
            format!("claude-swap isn't installed on {name}, so its Claude login's quota can't be read"),
            format!("{name} 没装 claude-swap，读不到那台机器上 Claude 登录的额度"))),
        Some("cswapTimeout") => {
            let seconds = answer["seconds"].as_u64().unwrap_or_default();
            return part(unknown("cswapTimeout", format!("{name}: cswap list did not answer within {seconds} s"),
                format!("{name}：cswap list 在 {seconds} 秒内没有回答")));
        }
        Some("cswapError") => {
            let kind: String = answer["type"].as_str().unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).take(64).collect();
            return part(unknown("cswapError", format!("{name}: cswap list refused: {kind}"), format!("{name}：cswap list 报错：{kind}")));
        }
        Some(_) => return failed(),
        None if !answer.is_object() => return failed(),
        None => {}
    }
    if answer["schemaVersion"].as_u64() != Some(1) {
        let version = answer["schemaVersion"].as_u64().map_or("none".to_owned(), |v| v.to_string());
        return part(unknown("cswapSchema",
            format!("{name}: cswap list answered schema {version} (Core reads schema 1, as claude-swap {} writes)", routing_accounts::CSWAP_PINNED),
            format!("{name}：cswap list 的格式版本是 {version}（Core 读的是 claude-swap {} 的版本 1）", routing_accounts::CSWAP_PINNED)));
    }
    let active = &answer["active"];
    if !active.is_object() {
        return part(unknown("noActiveAccount", format!("claude-swap on {name} marks no account as its default login"),
            format!("{name} 上的 claude-swap 没标出当前登录的账号")));
    }
    let status: String = active["usageStatus"].as_str().unwrap_or("none").chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(32).collect();
    match routing_accounts::window(&active["sevenDay"]) {
        Some(week) if status == "ok" => json!({"week": week, "source": "cswap"}),
        _ => part(unknown(&format!("usage:{status}"), format!("{name}: claude-swap has no usage for its default login ({status})"),
            format!("{name}：claude-swap 没有当前登录账号的用量（{status}）"))),
    }
}

/// The Codex login on the machine `name`, from the helper's answer
/// (remote_helper.py `codex_quota`), as a reading keeps it: its week, or why
/// it is unknown, in the words `codex_quota` has for this host's.
pub(crate) fn machine_codex(name: &str, answer: &Value) -> Value {
    let code = match answer["error"].as_str() {
        Some(code) => Some(code),
        None if !answer.is_object() => Some("codexUnreadable"),
        None if answer["signedIn"] != true => Some("notSignedIn"),
        None if answer["accountType"] != "chatgpt" => Some("notSubscription"),
        None => None,
    };
    match code {
        Some("notSignedIn") => json!({"unknown": unknown("notSignedIn", format!("{name}: Codex is not signed in"), format!("{name}：Codex 没有登录")),
            "source": "codex"}),
        Some(code) => json!({"unknown": on_machine(name, codex_unknown(code)), "source": "codex"}),
        None => {
            let mut reading = codex_windows(&answer["limits"]);
            reading["source"] = "codex".into();
            reading
        }
    }
}

/// What the machine's own logins have left (YN-175): `claude`, claude-swap's
/// default-login account there, and `codex`, its Codex login, each as asked.
/// On a machine that keeps its Agents contained, Claude runs with folders of
/// its own (remote_helper.py `session_env`), a login claude-swap there doesn't
/// name: unknown, without asking.
async fn machine_reading(machine: &RemoteMachine, claude: bool, codex: bool) -> Value {
    let name = machine.name.as_str();
    let mut reading = json!({"name": name});
    let ask_cswap = claude && !machine.contained;
    if claude && machine.contained {
        reading["claude"] = json!({"unknown": unknown("containedLogin",
            format!("On {name}, Claude keeps its own folders; that login's quota isn't read"),
            format!("{name} 上的 Claude 用自己的会话目录，读不到那份登录的额度")), "source": "cswap"});
    }
    if !ask_cswap && !codex {
        return reading;
    }
    match crate::remote::quota(machine, ask_cswap, codex.then_some(machine.codex.as_str())).await {
        Ok(answer) => {
            if ask_cswap {
                reading["claude"] = machine_claude(name, &answer["cswap"]);
            }
            if codex {
                reading["codex"] = machine_codex(name, &answer["codex"]);
            }
        }
        Err(_) => {
            let why = unknown("machineUnreachable", format!("Couldn't reach {name} to read its quota"), format!("连不上 {name}，读不到它的额度"));
            if ask_cswap {
                reading["claude"] = json!({"unknown": why, "source": "cswap"});
            }
            if codex {
                reading["codex"] = json!({"unknown": why, "source": "codex"});
            }
        }
    }
    reading
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

    /// Drops the readings of `prefix` (`codex:` or `machine:`) whose id is not in
    /// `ids`: a Codex home no longer listed, a machine no longer needed or removed.
    fn keep_quotas(&self, prefix: &str, ids: &[String]) -> Result<()> {
        let mut db = self.db.write()?;
        let tx = db.transaction()?;
        let sources: Vec<String> = tx.prepare("SELECT source FROM routing_quotas WHERE substr(source, 1, length(?1)) = ?1")?
            .query_map([prefix], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
        for source in sources {
            if !source.strip_prefix(prefix).is_some_and(|id| ids.iter().any(|kept| kept == id)) {
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

/// claude-swap's accounts as a reading keeps them: each one's number,
/// fingerprint, whether it is the default login, and its week, or why its
/// usage is unknown. A started executor's account is judged on a fresh list
/// read the same way (routing_launch.rs `move_account`, YN-138).
pub(crate) fn cswap_reading(accounts: &[routing_accounts::Account]) -> Value {
    json!({"accounts": accounts.iter().map(|a| {
        let mut row = json!({"number": a.number, "fingerprint": a.fingerprint, "active": a.active, "source": "cswap"});
        if let Some(w) = &a.week { row["week"] = json!(w); }
        if a.usage_status.as_deref() != Some("ok") || a.week.is_none() {
            let status = a.usage_status.clone().unwrap_or_else(|| "none".into());
            row["unknown"] = unknown(&format!("usage:{status}"), format!("claude-swap has no usage for this account ({status})"),
                format!("claude-swap 没有这个账号的用量（{status}）"));
        }
        row
    }).collect::<Vec<_>>()})
}

/// Whether a reading observed at `at` is stale now.
pub fn stale(at: &str, now: DateTime<Utc>) -> bool {
    DateTime::parse_from_rfc3339(at).map_or(true, |t| (now - t.with_timezone(&Utc)).num_seconds() > STALE_AFTER_SECONDS)
}

/// A reading without the 5-hour window an older Core kept.
fn weeks_only(reading: &mut Value) {
    if let Some(map) = reading.as_object_mut() {
        map.remove("fiveHour");
    }
}

/// The kept readings in the shape of `GET /api/routing/readings`: `{cswap, codex}`.
/// A 5-hour window an older Core kept is left out (YN-60).
pub fn view(kept: &[(String, Value, String)], now: DateTime<Utc>) -> (Value, Value) {
    let mut cswap = Value::Null;
    let mut codex = Vec::new();
    for (source, reading, at) in kept {
        if source == "cswap" {
            let mut r = reading.clone();
            r.get_mut("accounts").and_then(Value::as_array_mut).into_iter().flatten().for_each(weeks_only);
            r["observedAt"] = at.clone().into();
            r["stale"] = stale(at, now).into();
            cswap = r;
        } else if let Some(home) = source.strip_prefix("codex:") {
            let mut r = reading.clone();
            weeks_only(&mut r);
            r["home"] = home.into();
            r["observedAt"] = at.clone().into();
            r["source"] = "codex".into();
            r["stale"] = stale(at, now).into();
            codex.push(r);
        }
    }
    (cswap, Value::Array(codex))
}

/// Each machine's own logins as kept (YN-175), in the shape of the readings'
/// `machines`: `{machine, name, observedAt, stale, claude?, codex?}`.
pub fn machines_view(kept: &[(String, Value, String)], now: DateTime<Utc>) -> Value {
    Value::Array(kept.iter().filter_map(|(source, reading, at)| {
        let id = source.strip_prefix("machine:")?;
        let mut r = reading.clone();
        r["machine"] = id.into();
        r["observedAt"] = at.clone().into();
        r["stale"] = stale(at, now).into();
        Some(r)
    }).collect())
}

impl Workspace {
    /// Reads the quotas `needs` names now, and keeps each with its time.
    pub(crate) async fn refresh_quotas(self: &Arc<Self>, needs: &Needs) -> Result<()> {
        if needs.cswap {
            let command = self.stored(|store| store.cswap_settings()).await?.command;
            let at = Utc::now();
            let reading = match routing_accounts::cswap_accounts(&command).await {
                Ok(accounts) => cswap_reading(&accounts),
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
            self.stored(move |store| store.keep_quotas("codex:", &ids)).await?;
            for (id, env) in targets {
                let at = Utc::now();
                let reading = codex_quota(&self.program, &env).await;
                self.stored(move |store| store.put_quota(&format!("codex:{id}"), &reading, at)).await?;
            }
        }
        // YN-175: each machine's own logins, one machine after another, one request
        // each. Codex runs on no contained machine (routing_policy::dispatch
        // `unavailable`). A machine no longer needed, or removed, leaves the readings.
        let wanted: Vec<(RemoteMachine, bool, bool)> = self.stored(|store| store.machines()).await?.into_iter()
            .filter_map(|m| {
                let claude = needs.claude_machines.wants(&m.id);
                let codex = needs.codex_machines.wants(&m.id) && !m.contained;
                (claude || codex).then_some((m, claude, codex))
            })
            .collect();
        let ids: Vec<String> = wanted.iter().map(|(m, _, _)| m.id.clone()).collect();
        self.stored(move |store| store.keep_quotas("machine:", &ids)).await?;
        for (machine, claude, codex) in wanted {
            let at = Utc::now();
            let reading = machine_reading(&machine, claude, codex).await;
            self.stored(move |store| store.put_quota(&format!("machine:{}", machine.id), &reading, at)).await?;
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
